Calendar MCP Server for Windows
===============================

This installer adds a local MCP server for CalDAV calendars. It needs no Node.js
installation. It reads calendars and can create meetings or answer invitations
after you confirm each change.

Requirements
------------
- 64-bit Windows.
- A CalDAV server reachable over HTTPS (Nextcloud, Radicale, Fastmail, etc.).
- An app password for that server.

Configure
---------
1. Open the installation folder from the Start Menu:
   "Calendar Config Folder".
2. Copy calendar.json.example to calendar.json.
3. Edit calendar.json:

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

Set calendarHome only if automatic discovery fails. calendar.json contains a
password; keep it private.

Start the server
----------------
Start "Calendar MCP Server" from the Start Menu. A console window opens and
prints:

    calendar-mcp HTTP server listening on 127.0.0.1:8767
    Use the following MCP endpoint in Chat AI:
    http://127.0.0.1:8767/mcp

Keep that window open while Chat AI uses the server. Closing the window stops
the server.

Use it in Chat AI
-----------------
Add a remote MCP server with the URL:
    http://127.0.0.1:8767/mcp

Use a Chat AI instance served locally over HTTP. An HTTPS page may block the
local HTTP endpoint as mixed content.

Optional authentication:
    setx CALENDAR_MCP_TOKEN "a-long-random-token"
Then send the header:
    Authorization: Bearer <token>

Tools
-----
- list_calendars
- list_events
- get_event
- create_event (confirmed)
- respond_to_event (confirmed)

Meeting invitations are sent by the CalDAV server's scheduling support. The
server account must allow scheduling/iTIP; otherwise attendees are stored on the
event but no email is sent. Times are stored in UTC. Date-only events are
all-day and the end date is exclusive.

Confirmation
------------
Every create or response opens a native window with:
- Allow once: only this change.
- Allow for session: future changes of the same kind until the server stops.
- Deny: nothing changes.

Security
--------
- The server binds to 127.0.0.1 only.
- It never logs or returns the CalDAV password.
- Use HTTPS and an app password, not your main password.
- Event text and attendee names are untrusted data.
- The executable and installer are unsigned. Windows SmartScreen may warn about
  them. Compare SHA256SUMS.txt before running them.

Uninstall
---------
Use "Uninstall Calendar MCP Server" in the Start Menu or Apps & features. This
removes the server and shortcuts. Delete calendar.json first if you want to
remove the saved credentials.
