# Thunderbird MCP Bridge extension

A Thunderbird 153+ privileged extension that lets `thunderbird-mcp` read accounts,
folders, messages, and raw bodies, search mail, create drafts, and set
read/unread/answered flags through Thunderbird itself.

Thunderbird performs every operation with its existing mail session. The MCP
server never receives IMAP credentials and never opens mbox files.

## Why this exists

Editing Thunderbird’s `.msf`/mbox files behind its back is not durable for IMAP:
Thunderbird re-syncs flags from the server and overwrites local edits. This
extension applies changes through Thunderbird’s APIs so reads and writes use the
normal Thunderbird code paths.

## How it works

The Unix socket transport is **opt-in** while it matures. Enable it in
Thunderbird's config editor (`about:config`) with:

```text
extensions.thunderbird-mcp.socket = true
```

Without that pref, the extension uses only the file bridge (the hardened
default). Do not enable it on a production profile until you have confirmed it
is stable on your Thunderbird build.

When enabled, the transport is a Unix domain socket inside the Thunderbird
profile:

```text
<profile>/thunderbird-mcp-bridge/mcp.sock   <- Unix socket (fallback name: s)
<profile>/thunderbird-mcp-bridge/socket.json <- chosen socket path
```

- The privileged Experiment API listens on the socket and speaks
  newline-delimited ASCII JSON. Multiple requests may be in flight.
- `background.js` runs several socket workers, so a slow command cannot block
  other commands.
- The MCP server connects to the socket and reconnects automatically. If the
  socket is unavailable, it falls back to the legacy command/result files.
- A separate heartbeat timer writes `status.json` every second, independent of
  command execution, so a long search cannot make the extension look offline.

The legacy file transport remains available:

```text
<profile>/thunderbird-mcp-bridge/commands/<id>.json   <- written by MCP/test client
<profile>/thunderbird-mcp-bridge/results/<id>.json    <- written by the extension
```

- `background.js` polls the command directory, executes commands, and writes
  results.
- `experiments/flags/` is a privileged Experiment API. It finds messages by RFC
  `Message-ID` and uses:
  - `folder.markMessagesRead([hdr], read)` for read/unread
  - `folder.addMessageDispositionState(hdr, nsMsgDispositionState_Replied)` for
    answered
- Everything lives under the profile directory, so this works with a
  snap-confined Thunderbird. No native messaging host and no IMAP password are
  needed.

## Install

1. In Thunderbird, open **Tools → Developer Tools → Debug Add-ons**.
2. Click **Load Temporary Add-on…** and select this folder’s `manifest.json`.
3. Keep Thunderbird running.

Temporary add-ons are removed when Thunderbird closes. For a permanent install,
package the folder as an `.xpi` and install it through the add-on manager.

The extension is privileged (Experiment API). Only load it from source you
trust.

## Test

Use the RFC `Message-ID` without angle brackets:

```bash
node test-client.js \
  --profile ~/.thunderbird/xxxxxxxx.default-release \
  "abc123@example.com" \
  --read --answered
```

The result is printed as JSON.

## MCP server integration

The MCP server uses this extension for all mail operations when the heartbeat
file is fresh:

```text
<profile>/thunderbird-mcp-bridge/status.json
```

The extension rewrites it every second. If the file is missing or older than
five seconds, the server reports that Thunderbird/extension is unavailable.
There is no local file fallback.

## Commands

Write one JSON file per command into
`<profile>/thunderbird-mcp-bridge/commands/`. Supported commands:

- `accounts` — accounts, identities, and folders.
- `folders` — all folders, optionally with message counts.
- `list` — messages in a folder by `folderId`, with `unreadOnly`,
  `fromDate`/`toDate`, `limit`, and `offset`. Set `includePreview` to add the
  first few body lines and the salutation to each returned message.
- `preview` — for `messageIds`, return the first few decoded body lines
  (`preview`) and the first salutation-like line (`salutation`).
- `read` — raw RFC 822 source by `messageId` or `headerMessageId`.
- `search` — native Thunderbird filters: `query` (`fullText`), `author`,
  `recipients`, `subject`, `body`, `folderId`/`folderIds`, `unreadOnly`,
  `flagged`, `hasAttachment`, `fromDate`/`toDate`, `tags`/`tagMode`, and
  `sizeMin`/`sizeMax`.
- `saveDraft` — create a draft with `identityEmail`, `to`, `cc`, `bcc`,
  `subject`, `text`/`html`, `inReplyTo`, `references`, and `attachments`.
- `mark` — set `read`, `answered`, and/or `priority` by `headerMessageId` or
  extension `messageId`. Priority is a numeric Thunderbird value: 1 none,
  2 lowest, 3 low, 4 normal, 5 high, 6 highest. Every attempt is appended
  locally to `<profile>/thunderbird-mcp-bridge/mark-log.jsonl`.
- `diagnose` — return profile, socket status, heartbeat, and module health.

Example:

```json
{
  "id": "unique-id",
  "command": "mark",
  "headerMessageId": "abc123@example.com",
  "read": true,
  "answered": true
}
```

The extension deletes processed command files and writes the matching result to
`<profile>/thunderbird-mcp-bridge/results/<id>.json`.

## Privacy

See [PRIVACY.md](PRIVACY.md). In short: the extension has no network access,
collects nothing, stores no credentials, and only exchanges local command/result
files with the MCP server under your Thunderbird profile.


## Mark log

Successful and failed mark attempts are appended to
`<profile>/thunderbird-mcp-bridge/mark-log.jsonl`. Each line records the time,
message id, account key, folder URI, message key, subject, sender, requested and
resulting read/answered state, and success or error. The log is local-only and
contains no message body.

## Security and limitations

- No IMAP credentials are stored or exposed.
- The extension never sends, deletes, or moves mail. It creates drafts and
  changes read/answered flags.
- Thunderbird must be running.
- The first message matching a `Message-ID` across all folders is used. If the
  same Message-ID exists in multiple folders, the result may target the wrong
  copy.
- The command/result directories are under the Thunderbird profile and are
  readable/writable by the local user only.
