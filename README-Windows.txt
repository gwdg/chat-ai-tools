Local Folder MCP Server - Windows Guide
========================================

This guide explains how to build, install, and use the local folder MCP server
on Windows. The server gives Chat AI read-only access to local folders. Every
new folder access requires a native confirmation dialog.

The optional gateway/proxy and the example chatbot are separate tools in this
repository; this guide only covers the MCP server.


1. What you get
---------------

- `local-folder-mcp.exe` - a standalone executable with the Node.js runtime
  embedded. Node.js does not need to be installed on the target machine.
- `local-folder-mcp-setup.exe` - a per-user Inno Setup installer.
- A Start Menu shortcut that starts the server in HTTP mode.
- Native confirmation dialogs through Windows PowerShell / Windows Forms.

The server is read-only. It does not write, delete, rename, or execute files.


2. Requirements
---------------

Build machine (only needed when building from source):

- Windows 10 or Windows 11, x64.
- Node.js 22.x and npm.
- Inno Setup 6, only for creating the installer.
- PowerShell 5.1 or newer (built into Windows).

Target machine (after installation):

- Windows 10 or Windows 11, x64.
- PowerShell 5.1 or newer (built into Windows).
- No Node.js installation.
- No zenity, kdialog, Python, or other Linux tools.

The executable and installer are unsigned by default. Windows SmartScreen may
warn about them. Sign both with your organization certificate before
distributing them broadly.


3. Build from source
--------------------

Run these commands on Windows in PowerShell or Command Prompt.

    cd chat-ai-tools
    npm ci
    npm run build:windows

`npm run build:windows` copies the running node.exe, bundles the MCP server,
creates the Node SEA blob, and injects it with postject. The result is:

    build\windows\out\local-folder-mcp.exe

This step must run on Windows. The script copies the hosting node.exe, so it
does not cross-build a Windows executable from Linux or macOS.

To create the installer, install Inno Setup 6. For example:

    winget install JRSoftware.InnoSetup

or download it from https://jrsoftware.org/isdl.php.

Then compile the installer:

    & "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" build\windows\installer.iss

The installer is written to:

    build\windows\out\local-folder-mcp-setup.exe


4. Build with GitHub Actions
----------------------------

The repository contains a manual workflow:

    .github/workflows/build-windows-installer.yml

Steps:

1. Push the repository to GitHub.
2. Open Actions -> "Build Windows installer".
3. Choose "Run workflow".
4. Download the "local-folder-mcp-windows" artifact after the run.

The artifact contains both `local-folder-mcp.exe` and
`local-folder-mcp-setup.exe`.


5. Install
----------

1. Run `build\windows\out\local-folder-mcp-setup.exe`.
2. Follow the wizard. The installer is per-user and does not require admin
   rights.
3. The files are installed to:

       %LOCALAPPDATA%\ChatAITools\LocalFolderMCP

4. The installer adds a Start Menu shortcut:

       Local Folder MCP Server

5. The installer can start the server immediately. You can also start it later
   from the Start Menu.

The installer includes a short end-user guide:

       %LOCALAPPDATA%\ChatAITools\LocalFolderMCP\installer-readme.txt


6. Start the server
-------------------

Start "Local Folder MCP Server" from the Start Menu. A console window opens and
prints:

    local-folder-mcp HTTP server listening on 127.0.0.1:3921
    Use the following MCP endpoint in Chat AI:
    http://127.0.0.1:3921/mcp

Keep the console window open while Chat AI uses the server. Closing the window
stops the server.

The server binds to 127.0.0.1 only. It is not reachable from the internet.

To run the portable executable directly:

    "%LOCALAPPDATA%\ChatAITools\LocalFolderMCP\local-folder-mcp.exe" --http

Without `--http`, the executable runs in stdio mode for MCP clients that start
a child process.


7. Configure Chat AI
--------------------

1. Open Chat AI in a browser served locally over HTTP, for example:

       http://localhost:8080
       http://127.0.0.1:8080

2. Open the MCP server settings.
3. Add a server with the URL printed by the console:

       http://127.0.0.1:3921/mcp

4. No authorization header is required.
5. The assistant can now request access to local folders.

An HTTPS-hosted Chat AI page may block the local HTTP MCP endpoint as mixed
content. Use a locally served Chat AI page for the local endpoint.


8. Folder access confirmation
-----------------------------

The first time a folder is accessed, a native dialog appears with the exact
action and path. Choose:

- Allow for session - grants the folder and all subfolders until the server
  process stops.
- Allow once - grants only this request.
- Deny - blocks the request.

Default choices are Deny/No where the dialog supports it.

Grants are kept in memory only:

- They are shared by all connected MCP clients of the same server process.
- They are lost when the server stops or is restarted.
- No grants are written to disk.


9. Change the port or CORS origins
----------------------------------

The default HTTP port is 3921. Start the server from Command Prompt with a
different port:

    set MCP_FOLDER_HTTP_PORT=4000
    "%LOCALAPPDATA%\ChatAITools\LocalFolderMCP\local-folder-mcp.exe" --http

Then use the endpoint printed by the server, for example:

    http://127.0.0.1:4000/mcp

CORS accepts localhost and 127.0.0.1 origins by default. To allow a specific
other local origin, set a comma-separated list before starting:

    set MCP_FOLDER_CORS_ORIGIN=http://localhost:8080
    "%LOCALAPPDATA%\ChatAITools\LocalFolderMCP\local-folder-mcp.exe" --http

Do not set CORS to `*` unless you intentionally want every local website to be
able to contact the server.


10. Update
----------

1. Stop the running server (close its console window).
2. Build or download the new installer.
3. Run the new installer. It updates the files in place.
4. Start "Local Folder MCP Server" again.


11. Uninstall
-------------

Use one of these:

- Start Menu -> Local Folder MCP Server -> Uninstall Local Folder MCP Server.
- Windows Settings -> Apps -> Installed apps -> Local Folder MCP Server ->
  Uninstall.

The server stores no folder grants on disk, so uninstalling does not remove any
user data.


12. Troubleshooting
-------------------

Port already in use:
- The default port 3921 is occupied. Set `MCP_FOLDER_HTTP_PORT` to another port
  and restart from Command Prompt.

Chat AI cannot connect:
- Confirm the server console is still open.
- Confirm the URL matches the printed endpoint exactly.
- Use a Chat AI page served over HTTP on localhost or 127.0.0.1.
- An HTTPS page may block the local HTTP endpoint as mixed content.
- Check that no proxy or VPN configuration blocks 127.0.0.1.

No confirmation dialog appears:
- Start the server in your interactive desktop session, not as a Windows
  service or scheduled task in session 0.
- Confirm Windows PowerShell is available.
- If PowerShell is blocked by policy, the access request fails closed.

SmartScreen warning:
- The executable and installer are unsigned. Choose "More info" -> "Run
  anyway" only if you trust the build, or sign the files with your certificate.

Antivirus warning:
- Unsigned single-file executables are sometimes flagged. Sign the files and
  distribute them through your normal software channel.

Server stops immediately:
- Run `local-folder-mcp.exe --http` from Command Prompt to see the error.
- Check the exit code and the console output.

Health check:
- While the server is running, open:

      http://127.0.0.1:3921/health

  A working server answers:

      {"ok":true}


13. Security notes
------------------

- The server is read-only; it has no write, delete, rename, or execute tools.
- It binds to 127.0.0.1 only and cannot be reached over the internet.
- The native dialog is the authorization boundary. There is no auto-allow
  option.
- The MCP client can ask for any path, but the user must confirm the exact
  folder.
- Only connect MCP clients you trust. A malicious client can repeatedly open
  confirmation dialogs.
- The server does not contain an API key and does not contact the internet.
- Session grants are not persisted. Restarting the server resets them.
- Sign the executable and installer before broad distribution.


14. Developer notes
-------------------

- Source: `tools/local-folder-mcp/`
- Windows build: `build/windows/build-sea.mjs`
- Installer: `build/windows/installer.iss`
- End-user installer guide: `build/windows/installer-readme.txt`
- Tests: `npm test`
- Build-only dependencies: `esbuild`, `postject`
- Build output is ignored: `build/windows/out/`

The SEA build sets `MCP_SEA=1` in the bundle so the bundled server starts
without the ESM main-module guard. Do not remove that guard or the banner.

Run the tests before building:

    npm ci
    npm test
    npm run build:windows

For development, the server can also run directly with Node:

    npm run mcp:folder        # HTTP mode, prints the Chat AI endpoint
    npm run mcp:folder:stdio  # stdio mode
