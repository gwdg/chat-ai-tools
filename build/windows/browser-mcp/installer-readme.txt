Browser MCP Server for Windows
==============================

This installer adds a standalone browser MCP server for Chat AI. It needs no
Node.js installation. It drives the Google Chrome, Chromium, or Microsoft Edge
browser that is already installed on this computer; no browser is bundled.

Start the server
----------------
Start "Browser MCP Server" from the Start Menu. A console window opens and
prints:

    browser-mcp HTTP server listening on 127.0.0.1:3922
    Use the following MCP endpoint in Chat AI:
    http://127.0.0.1:3922/mcp
    Authentication: disabled (set MCP_BROWSER_TOKEN to require a Bearer token)
    MCP sessions: isolated browser contexts per session (idle 1800s, max 20)

Keep that window open while Chat AI uses the server. Closing the window stops
the server.

Use it in Chat AI
-----------------
1. In Chat AI, open the MCP server settings.
2. Add a server with the URL printed above, for example:
   http://127.0.0.1:3922/mcp
3. Ask the assistant to open a web page or read a page.

Use a Chat AI instance served locally over HTTP (http://localhost or
http://127.0.0.1). An HTTPS-hosted Chat AI page may block the local HTTP MCP
endpoint as mixed content.

Multiple chats
--------------
Each Chat AI chat that sends an Mcp-Session-Id gets its own browser context with
separate tabs and cookies. All sessions share one Chrome process. Idle sessions
expire after 30 minutes by default, and at most 20 sessions are kept.

Optional configuration
----------------------
Set user environment variables and then restart the server from the Start Menu:

    setx MCP_BROWSER_HTTP_PORT 3930
    setx MCP_BROWSER_TOKEN "a-long-random-token"
    setx BROWSER_MCP_CHROME_PATH "C:\Program Files\Google\Chrome\Application\chrome.exe"
    setx BROWSER_MCP_HUMANIZE 0
    setx BROWSER_MCP_ALLOWED_HOSTS "example.com,en.wikipedia.org"
    setx MCP_BROWSER_SESSION_IDLE_MS 1800000
    setx MCP_BROWSER_MAX_SESSIONS 20

When MCP_BROWSER_TOKEN is set, MCP clients must send:
    Authorization: Bearer <token>

Browser options:
- BROWSER_MCP_HUMANIZE=0 disables the human-like user agent, locale, mouse,
  typing, and scrolling behavior.
- BROWSER_MCP_ALLOWED_HOSTS limits navigation to the listed hosts.
- BROWSER_MCP_USER_DATA_DIR keeps cookies and logins in a profile directory.

Security
--------
- The server binds to 127.0.0.1 only and is not reachable from the internet.
- It contains no API key. Authentication is optional and disabled by default.
- Set MCP_BROWSER_TOKEN if other local users or processes can reach localhost.
- Page content and model output are untrusted. Do not enter secrets into pages
  you do not trust.
- The executable and installer are unsigned. Windows SmartScreen may warn about
  them. Compare the SHA256SUMS.txt values before running them.

Uninstall
---------
Use "Uninstall Browser MCP Server" in the Start Menu, or Apps & features in
Windows Settings. The browser profile is not created unless you set
BROWSER_MCP_USER_DATA_DIR; delete that directory manually if you used it.
