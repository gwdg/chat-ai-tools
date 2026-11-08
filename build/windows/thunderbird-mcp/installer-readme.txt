Thunderbird MCP Server for Windows
==================================

This installer adds a standalone local MCP server that reads Thunderbird mail
through a privileged Thunderbird extension. It needs no Node.js installation
and does not store IMAP/SMTP passwords.

Requirements
------------
- 64-bit Windows.
- Thunderbird 153 or newer, running.
- The bundled Thunderbird extension, loaded or installed (see below).

Install the Thunderbird extension
---------------------------------
The installer includes:

    thunderbird-mcp-extension.xpi
    extension\manifest.json

Temporary (removed when Thunderbird closes):
1. Open Thunderbird.
2. Open Tools -> Developer Tools -> Debug Add-ons.
3. Choose "Load Temporary Add-on" and select:
       %LOCALAPPDATA%\ChatAITools\ThunderbirdMCP\extension\manifest.json
4. Confirm the extension is enabled.

Permanent:
1. In Thunderbird, open Add-ons and Themes.
2. Open the gear menu and choose "Install Add-on From File".
3. Select:
       %LOCALAPPDATA%\ChatAITools\ThunderbirdMCP\thunderbird-mcp-extension.xpi
4. Confirm the installation.

The extension uses a privileged Experiment API. Only install it from source you
trust. If Thunderbird rejects the unsigned XPI, use the temporary add-on method,
or enable unsigned add-ons in Thunderbird's Config Editor with
xpinstall.signatures.required = false.

Start the server
----------------
Start "Thunderbird MCP Server" from the Start Menu. A console window opens,
creates a random bearer token on first run, and prints:

    Thunderbird MCP endpoint:
      http://127.0.0.1:8765/mcp

    Bearer token:
      <random token>

Keep that window open while Chat AI uses the server. Closing the window stops
the server. The token is stored in:

    %LOCALAPPDATA%\ChatAITools\ThunderbirdMCP\token.txt

Use it in Chat AI
-----------------
1. In Chat AI, add a remote MCP server with the URL printed above:
       http://127.0.0.1:8765/mcp
2. Add the header:
       Authorization: Bearer <token from the console or token.txt>
3. Ask the assistant about unread mail or to triage your inbox.

Use a Chat AI instance served locally over HTTP (http://localhost or
http://127.0.0.1). An HTTPS-hosted Chat AI page may block the local HTTP MCP
endpoint as mixed content.

Profile detection
-----------------
The server auto-detects Thunderbird profiles in
%APPDATA%\Thunderbird\profiles.ini (plus the usual Linux and macOS locations).
If several profiles exist, the default or most recently active profile is
preferred.

To choose a profile explicitly, set a user environment variable and restart the
server from the Start Menu:

    setx THUNDERBIRD_PROFILE "C:\Users\<you>\AppData\Roaming\Thunderbird\Profiles\xxxxxxxx.default-release"

The folder must contain prefs.js.

Other options
-------------
    setx THUNDERBIRD_MCP_PORT 8765
    setx THUNDERBIRD_MCP_READ_ONLY 1
    setx THUNDERBIRD_MCP_DEBUG 1

THUNDERBIRD_MCP_READ_ONLY=1 hides the draft, read-state, priority, and answered
tools. The server binds to 127.0.0.1 only by default.

Security
--------
- The server and extension exchange data locally under the Thunderbird profile.
- The server binds to 127.0.0.1 only and uses a per-install random Bearer token.
- The extension never sends, deletes, or moves mail. It creates drafts and marks
  read/answered/priority through Thunderbird.
- Treat token.txt as a secret. Anyone who can read it can use the local MCP
  endpoint.
- The executable and installer are unsigned. Windows SmartScreen may warn about
  them. Compare SHA256SUMS.txt before running them.

Uninstall
---------
Use "Uninstall Thunderbird MCP Server" in the Start Menu, or Apps & features in
Windows Settings. This removes the server, the extension files, and token.txt.
It does not modify your Thunderbird profile or mail.
