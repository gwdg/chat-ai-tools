Local Folder MCP Server
=======================

This installer provides a standalone local MCP server for Chat AI. It needs no
Node.js installation. On Windows the confirmation dialogs use the built-in
Windows PowerShell / Windows Forms dialog.

Start the server
----------------
Start "Local Folder MCP Server" from the Start Menu. A console window opens and
prints:

    local-folder-mcp HTTP server listening on 127.0.0.1:3921
    Use the following MCP endpoint in Chat AI:
    http://127.0.0.1:3921/mcp

Keep that window open while Chat AI uses the server. Closing the window stops
the server.

Use it in Chat AI
-----------------
1. In Chat AI, open the MCP server settings.
2. Add a server with the URL printed above, for example:
   http://127.0.0.1:3921/mcp
3. Ask the assistant about local files.

Use a Chat AI instance served locally over HTTP (http://localhost or
http://127.0.0.1). An HTTPS-hosted Chat AI page may block the local HTTP MCP
endpoint as mixed content.

Access confirmation
-------------------
The first time each folder is accessed, a native dialog appears with the exact
path. Choose:

- Allow for session: grants the folder and all subfolders until the server stops.
- Allow once: grants only this request.
- Deny: blocks access.

Grants are kept in memory only and are lost when the server stops.

Security
--------
- The server is read-only. It has no write, delete, rename, or execute tools.
- It binds to 127.0.0.1 only and is not reachable from the internet.
- The server does not contain an API key and does not contact the internet.
- Only connect MCP clients you trust.

Configuration
-------------
The default port is 3921. To change it, set MCP_FOLDER_HTTP_PORT before starting
the server, or start local-folder-mcp.exe with the environment variable set.
