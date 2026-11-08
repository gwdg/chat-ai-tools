Chromium MCP Browser Control for Windows
=========================================

This installer adds a local MCP relay that controls Chromium, Google Chrome, or
Microsoft Edge through the bundled extension. It needs no Node.js installation.

Requirements
------------
- 64-bit Windows.
- Chromium, Google Chrome, or Microsoft Edge version 116 or newer.
- The bundled extension loaded from:
      %LOCALAPPDATA%\ChatAITools\ChromiumMCP\extension

Load the extension
------------------
1. Open chrome://extensions (or edge://extensions).
2. Enable Developer mode.
3. Choose "Load unpacked" and select:
       %LOCALAPPDATA%\ChatAITools\ChromiumMCP\extension
4. Open the extension's Options page.
5. Keep the relay URL ws://127.0.0.1:8766/extension and choose
   "Save and connect". The toolbar badge shows ON when connected.

The extension is not auto-installed into the browser profile; loading it
unpacked is deliberate because it is a development/privileged tool.

Start the relay
---------------
Start "Chromium MCP Relay" from the Start Menu. A console window opens and
prints:

    chromium-mcp HTTP server listening on 127.0.0.1:8766
    Use the following MCP endpoint in Chat AI:
    http://127.0.0.1:8766/mcp
    Extension WebSocket:
    ws://127.0.0.1:8766/extension

Keep the window open while Chat AI uses the browser. Closing it stops the relay.

Use it in Chat AI
-----------------
Add a remote MCP server with the URL:
    http://127.0.0.1:8766/mcp

Use a Chat AI instance served locally over HTTP. An HTTPS page may block the
local HTTP endpoint as mixed content.

Tab confirmation
----------------
Every tab read or action opens a confirmation window showing the purpose, tab
title, site, and URL. Choose:
- Allow once: only this request.
- Allow for session: this tab and site until the browser closes. Approvals can
  be revoked from the extension toolbar popup.
- Deny: the request fails.

Approvals are tied to the tab and site. Navigating a tab to another site asks
again. Tabs that are not approved hide their title and URL in browser_tabs.

Optional configuration
----------------------
Set user environment variables and restart the relay from the Start Menu:

    setx MCP_CHROMIUM_HTTP_PORT 8766
    setx MCP_CHROMIUM_TOKEN "a-long-random-mcp-token"
    setx MCP_CHROMIUM_EXTENSION_TOKEN "a-different-extension-token"

If MCP_CHROMIUM_TOKEN is set, Chat AI must send:
    Authorization: Bearer <token>

If MCP_CHROMIUM_EXTENSION_TOKEN is set, enter the same value on the extension
Options page.

Security
--------
- The relay binds to 127.0.0.1 only and is not reachable from the internet.
- WebSocket connections must come from a chrome-extension:// origin.
- No authentication is required by default. Set the tokens above if other local
  users or processes can reach localhost.
- The extension reads and controls only tabs you approve. It cannot control
  chrome://, edge://, about:, or file: pages.
- Page content and model output are untrusted. Do not enter secrets into pages
  you do not trust.
- The executable and installer are unsigned. Windows SmartScreen may warn about
  them. Compare SHA256SUMS.txt before running them.

Uninstall
---------
Use "Uninstall" in the Start Menu or Apps & features. This removes the relay,
the extension files, and the Start Menu shortcuts. Remove the unpacked extension
from chrome://extensions first if it is still loaded.
