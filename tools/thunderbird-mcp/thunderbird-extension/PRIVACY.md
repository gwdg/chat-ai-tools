# Privacy Policy — Thunderbird MCP Bridge

**Last updated:** 2026-11-03

This policy covers the **Thunderbird MCP Bridge** extension and its companion
local **thunderbird-mcp** server.

## Summary

- The extension **does not collect, transmit, sell, or share personal data**.
- It has **no network access** and makes **no external requests**.
- It does **not read or store IMAP/SMTP credentials**.
- It reads mail and applies changes through Thunderbird’s own APIs, so
  Thunderbird can sync flags to your mail server.
- The MCP server runs **locally**. Any email content processed by an AI client
  may be sent to that client’s configured model provider; that is outside this
  extension and is governed by that provider’s privacy policy.

## What the extension accesses

When you ask an MCP client to list, read, search, draft, or mark mail, the
extension uses Thunderbird’s WebExtension and privileged Experiment APIs to:

- list accounts, identities, and folders,
- list messages and read raw message sources,
- search message content with Thunderbird’s `fullText` query,
- save drafts in Thunderbird,
- set read or answered flags, and
- return the requested data to the local MCP server.

The extension does **not** read contacts, calendars, or passwords.

## How it works with an MCP server

1. The **MCP server** runs on your machine and exposes mail tools to your AI
   client.
2. For flag changes, the server writes a small JSON command file under your
   Thunderbird profile:

   ```text
   <profile>/thunderbird-mcp-bridge/commands/<id>.json
   ```

3. The extension polls that directory, performs the flag change inside
   Thunderbird, and writes a JSON result:

   ```text
   <profile>/thunderbird-mcp-bridge/results/<id>.json
   ```

4. The extension also writes a heartbeat file
   `<profile>/thunderbird-mcp-bridge/status.json` once per second so the MCP
   server knows the bridge is available.
5. Each mark attempt is appended locally to
   `<profile>/thunderbird-mcp-bridge/mark-log.jsonl`. The log contains the
   timestamp, message id, account key, folder URI, message key, subject, sender,
   requested and resulting read/answered state, and success or error. It contains
   no message body.

The command/result files can contain message metadata, raw message bodies,
search results, draft content, and flag values. They do not contain passwords or
OAuth tokens. The extension deletes command files after
processing them; result files are small and can be deleted at any time. The
entire `thunderbird-mcp-bridge` directory can be removed without affecting your
mail.

## Network activity and third parties

- The extension makes **no network connections**.
- The MCP server itself does **not** contact external services; it communicates
  with Thunderbird through local files.
- If you connect the MCP server to an AI assistant, that assistant may send
  email content to its model provider to answer your request. That processing is
  performed by the AI client, not by this extension. Review your AI provider’s
  privacy policy before using it with email data.

## Credentials

The extension never asks for, reads, or stores your email password, OAuth token,
or IMAP/SMTP credentials. Thunderbird remains responsible for authenticating to
your mail server and syncing flags.

## Data retention

- `status.json`: overwritten every second; no history is kept.
- `commands/*.json`: deleted by the extension after processing.
- `results/*.json`: retained until the MCP server or user removes them; they
  contain only message identifiers and flag results.

No analytics, telemetry, advertising, or tracking is used.

## Your control

You can stop all data access at any time by:

- disabling or removing the extension in Thunderbird’s Add-ons Manager, and
- deleting `<profile>/thunderbird-mcp-bridge/`.

Temporary add-ons are removed automatically when Thunderbird closes.

## Changes

If this policy changes, the updated version will be published with the
extension and the date above will be revised.

## Contact

For privacy questions, open an issue in the project repository or contact the
project maintainer through the distribution channel where you obtained the
extension.
