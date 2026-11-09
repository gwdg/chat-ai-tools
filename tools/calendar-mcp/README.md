# calendar-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server for
CalDAV calendars. It can list calendars and events, read event details, create
meetings with invited attendees, and accept/decline/tentatively accept meeting
invitations.

Reads are free. Every change opens a native confirmation dialog with **Allow
once**, **Allow for session**, and **Deny**, like the other local MCP servers.
Session approvals are kept in memory until the server stops.

## Requirements

- Node.js 20 or newer.
- A CalDAV server (Nextcloud, Radicale, Fastmail, or similar) reachable over
  HTTPS.
- An app password or equivalent CalDAV password. Do not use your main account
  password.

## Configuration

Copy the example and edit it:

```bash
cp secrets/calendar.json.example secrets/calendar.json
```

```json
{
  "baseUrl": "https://cloud.example.com/remote.php/dav",
  "username": "your-user",
  "password": "your-app-password",
  "email": "you@example.com",
  "displayName": "Your Name",
  "calendarHome": "",
  "defaultCalendar": "",
  "readOnly": false,
  "timeoutMs": 30000
}
```

- `baseUrl` — CalDAV server root. Must use `https`, except for
  localhost/127.0.0.1 testing.
- `email` — your address. It becomes the event organizer and is used to find
  your ATTENDEE line when responding to invitations.
- `calendarHome` — optional calendar-home URL if discovery is not available.
- `defaultCalendar` — optional calendar id, URL, or display name for new
  meetings.
- `calendars` — optional explicit list if discovery is not available:
  `[{ "name": "Personal", "url": "https://.../calendars/user/personal/", "readOnly": false }]`.
- `readOnly` — hide changes even if the server allows them.
- `CALENDAR_CONFIG` or `--config` overrides the config path.

The config contains a password. It lives under `secrets/`, which is ignored by
git. The server never logs the password and never returns it.

## Run

### Make shortcuts

```bash
cd tools/calendar-mcp
make                 # install deps and run HTTP on 127.0.0.1:8767
make start CONFIG=~/calendar.json
make status
make stop
make restart
make test
```

### HTTP

```bash
npm install
node server.mjs --http --config ../../secrets/calendar.json
```

- MCP endpoint: `POST http://127.0.0.1:8767/mcp`
- Health: `GET http://127.0.0.1:8767/health`
- Optional bearer auth: set `CALENDAR_MCP_TOKEN` and send
  `Authorization: Bearer <token>`.
- CORS defaults to localhost/127.0.0.1 origins and `*.chat-ai.academiccloud.de`.
  `CALENDAR_MCP_CORS_ORIGIN` accepts a comma-separated list and supports `*` and
  `*.domain` wildcards.

Chat AI remote MCP configuration:

```json
{
  "type": "remote",
  "url": "http://127.0.0.1:8767/mcp"
}
```

### stdio

```bash
node server.mjs --config ../../secrets/calendar.json
# or: make stdio
```

## Tools

| Tool | Purpose |
|---|---|
| `list_calendars` | List calendars, colors, and writability. |
| `list_events` | List events in a time range; filter by calendar or text. |
| `get_event` | Full event details, attendees, organizer, and your status. |
| `create_event` | Create a meeting and invite attendees. Confirmed. |
| `respond_to_event` | Accept, tentatively accept, or decline an invitation. Confirmed. |

### Create a meeting

```json
{
  "summary": "Project kickoff",
  "start": "2026-12-01T10:00:00Z",
  "end": "2026-12-01T11:00:00Z",
  "location": "Room 4",
  "description": "Agenda: scope and milestones",
  "attendees": [
    { "email": "alice@example.com", "name": "Alice" },
    "bob@example.com"
  ]
}
```

- Times are stored in UTC. Use ISO-8601 values with an offset or `Z`.
- Date-only values (`2026-12-01`) create all-day events; `end` is exclusive.
- The event organizer is the configured `email`.
- Invitations are sent by the CalDAV server's scheduling support. The server
  and account must allow scheduling/iTIP; otherwise attendees are stored on the
  event but no email is sent.
- `calendar_id` selects a calendar. Without it, `defaultCalendar` or the first
  writable calendar is used.

### Respond to an invitation

```json
{
  "event_id": "https://cloud.example.com/remote.php/dav/calendars/user/personal/abc.ics",
  "response": "accepted"
}
```

The tool updates your `PARTSTAT` on the event and puts it back with
`If-Match` to avoid overwriting concurrent changes. The CalDAV server sends the
organizer reply. If you are the organizer, `accepted`/`tentative` marks the
event `CONFIRMED`; declining your own event is rejected because it would cancel
the meeting.

## Confirmation

`create_event` and `respond_to_event` call the native dialog before writing.
Choices:

- **Allow once** — only this request.
- **Allow for session** — all future actions of the same kind (create or
  respond) until the server stops.
- **Deny** — nothing is changed.

The dialog shows the meeting title, times, calendar, location, and attendees or
the invitation being answered. On Linux install `zenity` or `kdialog`; macOS uses
`osascript`; Windows uses PowerShell/WinForms.

## Security and limitations

- The server binds to `127.0.0.1` only and refuses a non-loopback `HOST`.
- It never logs or returns the CalDAV password.
- Use an app password and HTTPS. HTTP is allowed only for loopback testing.
- Credentials are sent only to the configured origin; cross-origin event URLs
  are rejected.
- Event descriptions, summaries, and attendee names are untrusted data.
- Recurring events are expanded with ical.js. Recurrence exceptions are applied
  when the server returns them in the same resource.
- Timezones are not written as VTIMEZONE; date-times are stored in UTC. All-day
  events use `VALUE=DATE` with an exclusive end date.
- There is intentionally no delete or arbitrary update tool. Creating meetings
  and responding to invitations are the only writes.

## Tests

```bash
npm test
```

Tests use a local mock CalDAV server and a fake confirmation dialog; they never
contact a real calendar.

## Windows installer

See [build/windows/calendar-mcp/README.md](../../build/windows/calendar-mcp/README.md)
for building the relay executable and NSIS installer on Linux.
