import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { ActionApprovals } from "../approvals.mjs";
import { createCalDavClient } from "../caldav.mjs";
import { validateConfig } from "../config.mjs";
import { createCalendarServer, createHttpServer } from "../server.mjs";

const AUTH = `Basic ${Buffer.from("me:secret").toString("base64")}`;

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:apple="http://apple.com/ns/ical/">
${responses.join("\n")}
</d:multistatus>`;
}

function xmlResponse(href, prop, etag) {
  return `<d:response>
  <d:href>${escapeXml(href)}</d:href>
  <d:propstat>
    <d:prop>${prop}${etag ? `<d:getetag>${escapeXml(etag)}</d:getetag>` : ""}</d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;
}

function eventIcs({
  uid,
  summary,
  start = "20261201T100000Z",
  end = "20261201T110000Z",
  organizer = "me@example.com",
  attendee = "",
  rrule = "",
  allDay = false,
}) {
  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:${uid}
DTSTAMP:20260101T000000Z
DTSTART${allDay ? ";VALUE=DATE" : ""}:${start}
DTEND${allDay ? ";VALUE=DATE" : ""}:${end}
SUMMARY:${summary}
ORGANIZER:mailto:${organizer}
${attendee ? `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee}` : ""}
${rrule ? `RRULE:${rrule}` : ""}
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;
}

async function startMockCalDav() {
  const events = new Map();
  let counter = 0;
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== AUTH) {
      response.writeHead(401);
      response.end();
      return;
    }
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (status, body, headers = {}) => {
      response.writeHead(status, {
        "Content-Type": "application/xml; charset=utf-8",
        ...headers,
      });
      response.end(body);
    };

    if (request.method === "PROPFIND" && url.pathname === "/dav/") {
      send(
        207,
        multistatus([
          xmlResponse(
            "/dav/",
            "<d:current-user-principal><d:href>/dav/principals/me/</d:href></d:current-user-principal>",
          ),
        ]),
      );
      return;
    }
    if (
      request.method === "PROPFIND" &&
      url.pathname === "/dav/principals/me/"
    ) {
      send(
        207,
        multistatus([
          xmlResponse(
            "/dav/principals/me/",
            "<c:calendar-home-set><d:href>/dav/calendars/me/</d:href></c:calendar-home-set>",
          ),
        ]),
      );
      return;
    }
    if (
      request.method === "PROPFIND" &&
      url.pathname === "/dav/calendars/me/"
    ) {
      send(
        207,
        multistatus([
          xmlResponse(
            "/dav/calendars/me/personal/",
            `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
             <d:displayname>Personal</d:displayname>
             <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
             <d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>
             <apple:calendar-color>#2563ebff</apple:calendar-color>`,
          ),
        ]),
      );
      return;
    }
    if (
      request.method === "REPORT" &&
      url.pathname === "/dav/calendars/me/personal/"
    ) {
      const responses = [];
      for (const [href, entry] of events) {
        responses.push(
          xmlResponse(
            href,
            `<c:calendar-data>${escapeXml(entry.ics)}</c:calendar-data>`,
            entry.etag,
          ),
        );
      }
      send(207, multistatus(responses));
      return;
    }
    if (request.method === "GET" && events.has(url.pathname)) {
      const entry = events.get(url.pathname);
      send(200, entry.ics, {
        "Content-Type": "text/calendar; charset=utf-8",
        ETag: entry.etag,
      });
      return;
    }
    if (request.method === "PUT" && url.pathname.endsWith(".ics")) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      const existing = events.get(url.pathname);
      if (request.headers["if-none-match"] === "*" && existing) {
        send(412, "exists");
        return;
      }
      if (
        request.headers["if-match"] &&
        (!existing || request.headers["if-match"] !== existing.etag)
      ) {
        send(412, "etag mismatch");
        return;
      }
      const etag = `"e${++counter}"`;
      events.set(url.pathname, { ics: body, etag });
      send(existing ? 204 : 201, "", { ETag: etag });
      return;
    }
    send(404, "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    events,
    baseUrl: `http://127.0.0.1:${port}/dav/`,
    calendarUrl: `http://127.0.0.1:${port}/dav/calendars/me/personal/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function configFor(baseUrl) {
  return validateConfig({
    baseUrl,
    username: "me",
    password: "secret",
    email: "me@example.com",
    displayName: "Me",
  });
}

test("validates calendar configuration", () => {
  const config = validateConfig({
    baseUrl: "https://cloud.example.com/remote.php/dav/",
    username: "u",
    password: "p",
    email: "u@example.com",
  });
  assert.equal(config.timeoutMs, 30000);
  assert.equal(config.readOnly, false);

  assert.doesNotThrow(() =>
    validateConfig({
      baseUrl: "http://127.0.0.1:8080/dav/",
      username: "u",
      password: "p",
      email: "u@example.com",
    }),
  );
  assert.throws(
    () =>
      validateConfig({
        baseUrl: "http://cloud.example.com/dav/",
        username: "u",
        password: "p",
        email: "u@example.com",
      }),
    /https/,
  );
  assert.throws(
    () =>
      validateConfig({
        baseUrl: "https://cloud.example.com/dav/",
        username: "u",
        password: "p",
        email: "not-an-email",
      }),
    /email/,
  );
});

test("discovers calendars and creates, lists, reads, and responds to events", async () => {
  const mock = await startMockCalDav();
  const client = createCalDavClient(configFor(mock.baseUrl));
  try {
    const calendars = await client.listCalendars();
    assert.equal(calendars.length, 1);
    assert.equal(calendars[0].name, "Personal");
    assert.equal(calendars[0].writable, true);

    const created = await client.createEvent({
      summary: "Kickoff",
      start: "2026-12-01T10:00:00Z",
      end: "2026-12-01T11:00:00Z",
      location: "Room 4",
      description: "Agenda",
      attendees: [{ email: "alice@example.com", name: "Alice" }],
    });
    assert.equal(created.summary, "Kickoff");
    assert.equal(created.all_day, false);
    assert.match(created.event_id, /\.ics$/);
    const createdIcs = mock.events
      .get(new URL(created.event_id).pathname)
      .ics.replace(/\r\n[ \t]/g, "");
    assert.match(createdIcs, /SUMMARY:Kickoff/);
    assert.match(createdIcs, /ATTENDEE;.*mailto:alice@example\.com/);
    assert.match(createdIcs, /ORGANIZER;.*mailto:me@example\.com/);

    const listed = await client.listEvents({
      from: "2026-11-01T00:00:00Z",
      to: "2026-12-31T23:59:59Z",
    });
    assert.equal(listed.events.length, 1);
    assert.equal(listed.events[0].summary, "Kickoff");
    assert.equal(listed.events[0].my_status, "organizer");

    const fetched = await client.getEvent(created.event_id);
    assert.equal(fetched.summary, "Kickoff");
    assert.equal(fetched.attendees[0].email, "alice@example.com");
    assert.equal(fetched.organizer, "me@example.com");
    assert.equal(fetched.my_status, "organizer");

    const allDay = await client.createEvent({
      summary: "Holiday",
      start: "2026-12-24",
      end: "2026-12-25",
    });
    assert.equal(allDay.all_day, true);
    const allDayIcs = mock.events.get(new URL(allDay.event_id).pathname).ics;
    assert.match(allDayIcs, /DTSTART;VALUE=DATE:20261224/);
    assert.match(allDayIcs, /DTEND;VALUE=DATE:20261225/);

    const inviteHref = "/dav/calendars/me/personal/invite.ics";
    mock.events.set(inviteHref, {
      etag: '"invite1"',
      ics: eventIcs({
        uid: "invite",
        summary: "Invitation",
        organizer: "boss@example.com",
        attendee: "me@example.com",
        start: "20261210T090000Z",
        end: "20261210T100000Z",
      }),
    });
    const invitation = await client.getEvent(
      `${mock.calendarUrl}invite.ics`,
    );
    assert.equal(invitation.my_status, "NEEDS-ACTION");

    const responded = await client.respondToEvent({
      event_id: `${mock.calendarUrl}invite.ics`,
      response: "accepted",
    });
    assert.equal(responded.my_status, "ACCEPTED");
    assert.match(
      mock.events.get(inviteHref).ics,
      /PARTSTAT=ACCEPTED/,
    );
  } finally {
    await mock.close();
  }
});

test("expands recurring events in the requested range", async () => {
  const mock = await startMockCalDav();
  const client = createCalDavClient(configFor(mock.baseUrl));
  try {
    mock.events.set("/dav/calendars/me/personal/weekly.ics", {
      etag: '"weekly"',
      ics: eventIcs({
        uid: "weekly",
        summary: "Weekly",
        start: "20260105T100000Z",
        end: "20260105T110000Z",
        rrule: "FREQ=WEEKLY;COUNT=3",
      }),
    });
    const listed = await client.listEvents({
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-31T23:59:59Z",
    });
    assert.equal(listed.events.length, 3);
    assert.ok(listed.events.every((event) => event.recurring));
  } finally {
    await mock.close();
  }
});

test("rejects event ids outside the configured origin", async () => {
  const mock = await startMockCalDav();
  const client = createCalDavClient(configFor(mock.baseUrl));
  try {
    await assert.rejects(
      () => client.getEvent("https://evil.example/event.ics"),
      /different origin/,
    );
  } finally {
    await mock.close();
  }
});

test("requires confirmation and supports read-only mode", async () => {
  const calls = [];
  const client = {
    async listCalendars() {
      return [{ id: "cal", name: "Cal", writable: true }];
    },
    async listEvents(args) {
      calls.push(["listEvents", args]);
      return { events: [], total: 0, truncated: false };
    },
    async getEvent(id) {
      return { event_id: id, summary: "Invite", start: "x", end: "y" };
    },
    async createEvent(args) {
      calls.push(["createEvent", args]);
      return { event_id: "id", summary: args.summary };
    },
    async respondToEvent(args) {
      calls.push(["respondToEvent", args]);
      return { event_id: args.event_id, my_status: "ACCEPTED" };
    },
  };
  const approvals = {
    calls: [],
    async require(key, action, details) {
      this.calls.push({ key, action, details });
      return "session";
    },
  };
  const server = createCalendarServer({ client, approvals, config: {} });
  const list = await server.handle("tools/list", {});
  assert.deepEqual(
    list.tools.map((tool) => tool.name),
    [
      "list_calendars",
      "list_events",
      "get_event",
      "create_event",
      "respond_to_event",
    ],
  );

  const created = await server.handle("tools/call", {
    name: "create_event",
    arguments: {
      summary: "Planning",
      start: "2026-12-01T10:00:00Z",
      end: "2026-12-01T11:00:00Z",
      attendees: ["alice@example.com"],
    },
  });
  assert.equal(created.isError, undefined);
  assert.equal(approvals.calls.length, 1);
  assert.equal(approvals.calls[0].key, "create_event");
  assert.match(approvals.calls[0].details, /alice@example.com/);

  const responded = await server.handle("tools/call", {
    name: "respond_to_event",
    arguments: { event_id: "event", response: "accepted" },
  });
  assert.equal(responded.isError, undefined);
  assert.equal(approvals.calls[1].key, "respond_to_event");

  const readOnly = createCalendarServer({
    client,
    approvals,
    config: { readOnly: true },
  });
  const blocked = await readOnly.handle("tools/call", {
    name: "create_event",
    arguments: {
      summary: "Blocked",
      start: "2026-12-01T10:00:00Z",
      end: "2026-12-01T11:00:00Z",
    },
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /read-only/i);
});

test("approvals honor once, session, and deny", async () => {
  const prompts = [];
  const approvals = new ActionApprovals({
    dialog: async ({ action }) => {
      prompts.push(action);
      return prompts.length === 1 ? "once" : prompts.length === 2 ? "session" : "deny";
    },
  });
  await approvals.require("create_event", "create", "details");
  await approvals.require("create_event", "create", "details");
  await approvals.require("create_event", "create", "details");
  assert.equal(prompts.length, 2);
  await assert.rejects(
    () => approvals.require("respond_to_event", "respond", "details"),
    /denied/i,
  );
});

test("serves MCP over HTTP with optional bearer auth", async () => {
  const client = {
    async listCalendars() {
      return [];
    },
    async listEvents() {
      return { events: [] };
    },
    async getEvent() {
      return {};
    },
    async createEvent() {
      return {};
    },
    async respondToEvent() {
      return {};
    },
  };
  const mcp = createCalendarServer({ client, config: {} });
  const server = createHttpServer({ mcp, token: "secret", corsOrigins: [] });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/mcp`;
  try {
    const unauthorized = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(base, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }),
    });
    assert.equal(authorized.status, 200);
    const body = await authorized.json();
    assert.equal(body.result.serverInfo.name, "calendar-mcp");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
