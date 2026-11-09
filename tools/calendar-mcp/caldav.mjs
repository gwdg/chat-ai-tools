import { randomUUID } from "node:crypto";

import { XMLParser } from "fast-xml-parser";
import ICAL from "ical.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`;

const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:apple="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <c:supported-calendar-component-set/>
    <d:current-user-privilege-set/>
    <d:getetag/>
    <apple:calendar-color/>
  </d:prop>
</d:propfind>`;

const VALID_RESPONSES = new Set(["accepted", "declined", "tentative"]);

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    if (typeof value["#text"] === "string") return value["#text"];
    if (typeof value.text === "string") return value.text;
    return "";
  }
  return String(value);
}

function stripMailto(value) {
  return String(value ?? "")
    .replace(/^mailto:/i, "")
    .trim();
}

function compactTime(date) {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function calendarQueryBody(from, to) {
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${compactTime(from)}" end="${compactTime(to)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

function parseMultiStatus(xml) {
  let document;
  try {
    document = xmlParser.parse(xml);
  } catch {
    throw new Error("The CalDAV server returned invalid XML.");
  }
  const responses = asArray(document?.multistatus?.response);
  return responses.map((response) => {
    const href = textOf(response.href);
    const propstats = asArray(response.propstat);
    let prop = {};
    for (const propstat of propstats) {
      if (!/\s2\d\d\s/.test(textOf(propstat.status))) continue;
      if (propstat.prop && typeof propstat.prop === "object") {
        prop = { ...prop, ...propstat.prop };
      }
    }
    return { href, prop };
  });
}

function timeToIso(time) {
  if (!time) return "";
  if (time.isDate) {
    const year = String(time.year).padStart(4, "0");
    const month = String(time.month).padStart(2, "0");
    const day = String(time.day).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return time.toJSDate().toISOString();
}

function isWritable(prop) {
  const privileges = asArray(prop["current-user-privilege-set"]?.privilege);
  if (!privileges.length) return true;
  return privileges.some((privilege) => {
    if (typeof privilege === "string") {
      return ["write", "write-content", "all"].includes(privilege);
    }
    return ["write", "write-content", "all"].some((name) =>
      Object.prototype.hasOwnProperty.call(privilege, name),
    );
  });
}

function componentsOf(prop) {
  const components = asArray(
    prop["supported-calendar-component-set"]?.comp,
  ).map((entry) =>
    typeof entry === "object" ? entry["@_name"] : String(entry),
  );
  return components.filter(Boolean);
}

function eventCalendar(prop) {
  const resourceType = prop.resourcetype;
  if (!resourceType || typeof resourceType !== "object") return false;
  return Object.prototype.hasOwnProperty.call(resourceType, "calendar");
}

function attendeeInfo(component) {
  return component.getAllProperties("attendee").map((property) => ({
    email: stripMailto(property.getFirstValue()),
    name: property.getParameter("cn") || "",
    status: String(property.getParameter("partstat") || "NEEDS-ACTION").toUpperCase(),
    role: property.getParameter("role") || "",
    rsvp: String(property.getParameter("rsvp") || "").toUpperCase() === "TRUE",
  }));
}

function organizerEmail(component) {
  return stripMailto(component.getFirstPropertyValue("organizer")).toLowerCase();
}

function myStatus(component, email) {
  const attendee = attendeeInfo(component).find(
    (entry) => entry.email.toLowerCase() === email,
  );
  if (attendee) return attendee.status || "NEEDS-ACTION";
  if (organizerEmail(component) === email) return "organizer";
  return "none";
}

function eventDetails(component, event, start, end, { recurring = false } = {}) {
  const summary = String(component.getFirstPropertyValue("summary") || "");
  const description = String(component.getFirstPropertyValue("description") || "");
  const location = String(component.getFirstPropertyValue("location") || "");
  const status = String(component.getFirstPropertyValue("status") || "");
  const sequence = component.getFirstPropertyValue("sequence");
  return {
    summary,
    description,
    location,
    status,
    sequence: sequence === undefined || sequence === null ? 0 : Number(sequence),
    start: timeToIso(start),
    end: timeToIso(end),
    all_day: Boolean(start?.isDate),
    organizer: organizerEmail(component),
    attendees: attendeeInfo(component),
    recurring,
    uid: String(component.getFirstPropertyValue("uid") || event?.uid || ""),
  };
}

function parseIcs(ics) {
  let root;
  try {
    root = new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new Error("The CalDAV server returned invalid iCalendar data.");
  }
  const components = root.getAllSubcomponents("vevent");
  if (!components.length) return null;
  const master =
    components.find((component) => !component.hasProperty("recurrence-id")) ||
    components[0];
  const event = new ICAL.Event(master);
  for (const component of components) {
    if (component === master) continue;
    try {
      event.relateException(new ICAL.Event(component));
    } catch {
      // Ignore malformed recurrence overrides.
    }
  }
  return { root, master, components, event };
}

function matchesQuery(entry, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  const haystack = [
    entry.summary,
    entry.description,
    entry.location,
    entry.organizer,
    ...entry.attendees.map((attendee) => `${attendee.name} ${attendee.email}`),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function parseDateInput(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  const text = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  if (dateOnly) {
    let time;
    try {
      time = ICAL.Time.fromDateString(text);
    } catch {
      throw new Error(`${field} must be a valid date.`);
    }
    return { time, dateOnly: true, js: time.toJSDate() };
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid ISO-8601 date or timestamp.`);
  }
  return {
    time: ICAL.Time.fromJSDate(date, true),
    dateOnly: false,
    js: date,
  };
}

function buildEventIcs(config, input, uid) {
  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.updatePropertyWithValue("prodid", "-//chat-ai-tools//calendar-mcp//EN");
  calendar.updatePropertyWithValue("version", "2.0");
  calendar.updatePropertyWithValue("calscale", "GREGORIAN");

  const event = new ICAL.Component("vevent");
  calendar.addSubcomponent(event);
  event.updatePropertyWithValue("uid", uid);
  event.updatePropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true),
  );
  event.updatePropertyWithValue("dtstart", input.start.time);
  event.updatePropertyWithValue("dtend", input.end.time);
  event.updatePropertyWithValue("summary", input.summary);
  if (input.description) {
    event.updatePropertyWithValue("description", input.description);
  }
  if (input.location) {
    event.updatePropertyWithValue("location", input.location);
  }
  event.updatePropertyWithValue("status", "CONFIRMED");
  event.updatePropertyWithValue("transp", "OPAQUE");
  event.updatePropertyWithValue("sequence", "0");

  const organizer = event.updatePropertyWithValue(
    "organizer",
    `mailto:${config.email}`,
  );
  organizer.setParameter("cn", config.displayName || config.email);
  organizer.setParameter("schedule-agent", "SERVER");

  for (const attendee of input.attendees) {
    const property = event.updatePropertyWithValue(
      "attendee",
      `mailto:${attendee.email}`,
    );
    property.setParameter("cn", attendee.name || attendee.email);
    property.setParameter("role", "REQ-PARTICIPANT");
    property.setParameter("partstat", "NEEDS-ACTION");
    property.setParameter("rsvp", "TRUE");
    property.setParameter("schedule-agent", "SERVER");
  }

  return calendar.toString();
}

function eventTarget(calendarUrl, uid) {
  const base = calendarUrl.endsWith("/") ? calendarUrl : `${calendarUrl}/`;
  return new URL(`${encodeURIComponent(uid)}.ics`, base).toString();
}

function normalizeAttendees(values, ownEmail) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error("attendees must be an array.");
  const seen = new Set();
  const result = [];
  for (const entry of values) {
    const email =
      typeof entry === "string"
        ? entry.trim()
        : typeof entry?.email === "string"
          ? entry.email.trim()
          : "";
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
      throw new Error(`Invalid attendee email: ${email || "(empty)"}.`);
    }
    const normalized = email.toLowerCase();
    if (normalized === ownEmail || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({
      email,
      name:
        typeof entry === "object" && typeof entry.name === "string"
          ? entry.name.trim()
          : "",
    });
  }
  return result;
}

export function createCalDavClient(config, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }
  const base = new URL(config.baseUrl);
  const authorization = `Basic ${Buffer.from(
    `${config.username}:${config.password}`,
  ).toString("base64")}`;
  let calendarCache = null;

  function resolveUrl(value, against = base) {
    const url = new URL(value, against);
    if (url.origin !== base.origin) {
      throw new Error(
        "Refusing to send calendar credentials to a different origin.",
      );
    }
    return url;
  }

  async function request(url, { method, body, headers = {}, expected = [200, 207, 201, 204] } = {}) {
    const target = resolveUrl(url);
    let response;
    try {
      response = await fetchImpl(target, {
        method,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: {
          Authorization: authorization,
          ...headers,
        },
      });
    } catch (error) {
      throw new Error(
        `Could not reach the calendar server: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!expected.includes(response.status)) {
      throw new Error(
        `CalDAV ${method} request failed with HTTP ${response.status}.`,
      );
    }
    return {
      status: response.status,
      etag: response.headers.get("etag") || "",
      text: await response.text(),
    };
  }

  async function propfind(url, depth, body) {
    const result = await request(url, {
      method: "PROPFIND",
      body,
      headers: {
        Depth: String(depth),
        "Content-Type": "application/xml; charset=utf-8",
      },
    });
    return parseMultiStatus(result.text);
  }

  async function discoverCalendarHome() {
    if (config.calendarHome) return config.calendarHome;
    const principalResponses = await propfind(base, 0, PROPFIND_PRINCIPAL);
    const principalHref = textOf(
      principalResponses[0]?.prop?.["current-user-principal"]?.href,
    );
    if (!principalHref) {
      throw new Error(
        "CalDAV discovery failed: set calendarHome in the config.",
      );
    }
    const principalUrl = resolveUrl(principalHref);
    const homeResponses = await propfind(principalUrl, 0, PROPFIND_HOME);
    const homeHref = textOf(
      homeResponses[0]?.prop?.["calendar-home-set"]?.href,
    );
    if (!homeHref) {
      throw new Error(
        "CalDAV discovery failed: set calendarHome in the config.",
      );
    }
    return resolveUrl(homeHref, principalUrl).toString();
  }

  async function listCalendars() {
    if (calendarCache && Date.now() - calendarCache.at < 60_000) {
      return calendarCache.value;
    }
    let calendars;
    if (config.calendars) {
      calendars = config.calendars.map((entry) => ({
        id: entry.url,
        name: entry.name,
        url: entry.url,
        color: "",
        writable: entry.readOnly !== true && !config.readOnly,
        components: ["VEVENT"],
      }));
    } else {
      const home = await discoverCalendarHome();
      const responses = await propfind(home, 1, PROPFIND_CALENDARS);
      calendars = responses
        .filter((response) => eventCalendar(response.prop))
        .map((response) => {
          const url = resolveUrl(response.href, home).toString();
          const components = componentsOf(response.prop);
          return {
            id: url,
            name:
              textOf(response.prop.displayname) ||
              decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "Calendar"),
            url,
            color: textOf(response.prop["calendar-color"]),
            writable: !config.readOnly && isWritable(response.prop),
            components,
          };
        })
        .filter(
          (calendar) =>
            !calendar.components.length ||
            calendar.components.includes("VEVENT"),
        );
    }
    calendars.sort((a, b) => a.name.localeCompare(b.name));
    calendarCache = { at: Date.now(), value: calendars };
    return calendars;
  }

  async function resolveCalendar(calendarId, { requireWritable = false } = {}) {
    const calendars = await listCalendars();
    let calendar;
    if (calendarId) {
      calendar =
        calendars.find((entry) => entry.id === calendarId) ||
        calendars.find((entry) => entry.url === calendarId) ||
        calendars.find(
          (entry) => entry.name.toLowerCase() === String(calendarId).toLowerCase(),
        );
      if (!calendar) {
        throw new Error(`Calendar not found: ${calendarId}.`);
      }
    } else if (config.defaultCalendar) {
      calendar =
        calendars.find(
          (entry) =>
            entry.name.toLowerCase() ===
            config.defaultCalendar.toLowerCase(),
        ) ||
        calendars.find((entry) => entry.url === config.defaultCalendar) ||
        calendars.find((entry) => entry.id === config.defaultCalendar);
      if (!calendar) {
        throw new Error(
          `Default calendar not found: ${config.defaultCalendar}.`,
        );
      }
    } else if (requireWritable) {
      calendar = calendars.find((entry) => entry.writable);
    } else {
      calendar = calendars[0];
    }
    if (!calendar) {
      throw new Error("No matching calendar found.");
    }
    if (requireWritable && !calendar.writable) {
      throw new Error(`Calendar is read-only: ${calendar.name}.`);
    }
    return calendar;
  }

  function calendarForEvent(calendars, eventUrl) {
    const url = resolveUrl(eventUrl);
    const calendar = calendars.find((entry) => {
      const baseUrl = new URL(entry.url);
      const basePath = baseUrl.pathname.endsWith("/")
        ? baseUrl.pathname
        : `${baseUrl.pathname}/`;
      return url.origin === baseUrl.origin && url.pathname.startsWith(basePath);
    });
    if (!calendar) {
      throw new Error("The event is not in a configured calendar.");
    }
    return calendar;
  }

  async function reportEvents(calendar, fromDate, toDate) {
    const result = await request(calendar.url, {
      method: "REPORT",
      body: calendarQueryBody(fromDate, toDate),
      headers: {
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
    });
    const responses = parseMultiStatus(result.text);
    return responses
      .map((response) => ({
        href: resolveUrl(response.href, calendar.url).toString(),
        etag: textOf(response.prop.getetag),
        ics: textOf(response.prop["calendar-data"]),
      }))
      .filter((entry) => entry.ics);
  }

  function eventOccurrences(parsed, calendar, href, etag, fromDate, toDate) {
    const { master, event } = parsed;
    const base = eventDetails(master, event, event.startDate, event.endDate);
    const participation = myStatus(master, config.email);
    const results = [];
    if (event.isRecurring()) {
      const iterator = event.iterator(
        ICAL.Time.fromJSDate(fromDate, true),
      );
      let occurrence;
      let guard = 0;
      while ((occurrence = iterator.next()) && guard < 5000) {
        guard += 1;
        const details = event.getOccurrenceDetails(occurrence);
        if (details.startDate.toJSDate() > toDate) break;
        if (details.endDate.toJSDate() < fromDate) continue;
        results.push({
          event_id: href,
          etag,
          calendar_id: calendar.id,
          calendar_name: calendar.name,
          ...base,
          ...eventDetails(
            master,
            event,
            details.startDate,
            details.endDate,
            { recurring: true },
          ),
          attendees: base.attendees,
          my_status: participation,
        });
      }
    } else if (
      event.endDate.toJSDate() >= fromDate &&
      event.startDate.toJSDate() <= toDate
    ) {
      results.push({
        event_id: href,
        etag,
        calendar_id: calendar.id,
        calendar_name: calendar.name,
        ...base,
        my_status: participation,
      });
    }
    return results;
  }

  async function listEvents({ calendarId, from, to, query, limit = 100 } = {}) {
    const fromDate = from ? new Date(from) : new Date();
    const toDate = to ? new Date(to) : new Date(fromDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new Error("from and to must be valid ISO-8601 dates.");
    }
    if (toDate <= fromDate) throw new Error("to must be after from.");
    const max = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const calendars = calendarId
      ? [await resolveCalendar(calendarId)]
      : await listCalendars();

    const events = [];
    for (const calendar of calendars) {
      const resources = await reportEvents(calendar, fromDate, toDate);
      for (const resource of resources) {
        const parsed = parseIcs(resource.ics);
        if (!parsed) continue;
        events.push(
          ...eventOccurrences(
            parsed,
            calendar,
            resource.href,
            resource.etag,
            fromDate,
            toDate,
          ),
        );
      }
    }

    const filtered = events
      .filter((entry) => matchesQuery(entry, query))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return {
      events: filtered.slice(0, max),
      total: filtered.length,
      truncated: filtered.length > max,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    };
  }

  async function fetchEventResource(eventId) {
    const calendars = await listCalendars();
    const calendar = calendarForEvent(calendars, eventId);
    const url = resolveUrl(eventId).toString();
    const result = await request(url, { method: "GET", expected: [200] });
    const parsed = parseIcs(result.text);
    if (!parsed) throw new Error("The event resource contains no VEVENT.");
    return { calendar, url, etag: result.etag, ics: result.text, parsed };
  }

  async function getEvent(eventId) {
    if (typeof eventId !== "string" || !eventId.trim()) {
      throw new Error("event_id is required.");
    }
    const { calendar, url, etag, parsed } = await fetchEventResource(eventId);
    const { master, event } = parsed;
    return {
      event_id: url,
      etag,
      calendar_id: calendar.id,
      calendar_name: calendar.name,
      ...eventDetails(master, event, event.startDate, event.endDate),
      my_status: myStatus(master, config.email),
      recurring: event.isRecurring(),
    };
  }

  async function createEvent(input) {
    if (config.readOnly) throw new Error("The calendar configuration is read-only.");
    const calendar = await resolveCalendar(input.calendar_id, {
      requireWritable: true,
    });
    if (typeof input.summary !== "string" || !input.summary.trim()) {
      throw new Error("summary is required.");
    }
    const start = parseDateInput(input.start, "start");
    const end = parseDateInput(input.end, "end");
    if (start.dateOnly !== end.dateOnly) {
      throw new Error("start and end must both be dates or both be date-times.");
    }
    if (end.js <= start.js) {
      throw new Error("end must be after start.");
    }
    const attendees = normalizeAttendees(
      input.attendees,
      config.email,
    );
    const uid = randomUUID();
    const ics = buildEventIcs(
      config,
      {
        summary: input.summary.trim(),
        description:
          typeof input.description === "string" ? input.description.trim() : "",
        location:
          typeof input.location === "string" ? input.location.trim() : "",
        start,
        end,
        attendees,
      },
      uid,
    );
    const target = eventTarget(calendar.url, uid);
    const result = await request(target, {
      method: "PUT",
      body: ics,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "If-None-Match": "*",
      },
      expected: [201, 204],
    });
    return {
      event_id: target,
      etag: result.etag,
      calendar_id: calendar.id,
      calendar_name: calendar.name,
      summary: input.summary.trim(),
      start: timeToIso(start.time),
      end: timeToIso(end.time),
      all_day: start.dateOnly,
      organizer: config.email,
      attendees: attendees.map((attendee) => ({
        ...attendee,
        status: "NEEDS-ACTION",
      })),
    };
  }

  async function respondToEvent({ event_id: eventId, response }) {
    if (config.readOnly) throw new Error("The calendar configuration is read-only.");
    if (!VALID_RESPONSES.has(response)) {
      throw new Error("response must be accepted, declined, or tentative.");
    }
    const { calendar, url, etag, ics, parsed } = await fetchEventResource(eventId);
    const { master, components } = parsed;
    const organizer = organizerEmail(master);
    const isOrganizer = organizer === config.email;

    if (isOrganizer && response === "declined") {
      throw new Error(
        "You are the organizer of this event; declining it would cancel the meeting. This tool only responds to invitations.",
      );
    }

    let updated = false;
    for (const component of components) {
      for (const property of component.getAllProperties("attendee")) {
        if (stripMailto(property.getFirstValue()).toLowerCase() !== config.email) {
          continue;
        }
        property.setParameter("partstat", response.toUpperCase());
        property.setParameter("rsvp", "FALSE");
        updated = true;
      }
      if (isOrganizer && component === master) {
        component.updatePropertyWithValue("status", "CONFIRMED");
        updated = true;
      }
    }
    if (!updated) {
      throw new Error("You are not an attendee of this event.");
    }

    const body = parsed.root.toString();
    const result = await request(url, {
      method: "PUT",
      body,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        ...(etag ? { "If-Match": etag } : {}),
      },
      expected: [201, 204],
    });

    const updatedParsed = parseIcs(body);
    const updatedMaster = updatedParsed?.master ?? master;
    return {
      event_id: url,
      etag: result.etag,
      calendar_id: calendar.id,
      calendar_name: calendar.name,
      summary: String(updatedMaster.getFirstPropertyValue("summary") || ""),
      start: timeToIso(
        updatedParsed?.event?.startDate ?? parsed.event.startDate,
      ),
      end: timeToIso(updatedParsed?.event?.endDate ?? parsed.event.endDate),
      response,
      my_status: isOrganizer ? "organizer" : response.toUpperCase(),
    };
  }

  return {
    listCalendars,
    listEvents,
    getEvent,
    createEvent,
    respondToEvent,
  };
}
