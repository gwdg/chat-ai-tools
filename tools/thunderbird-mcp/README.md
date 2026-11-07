# thunderbird-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server that
reads Thunderbird mail through a privileged Thunderbird extension. It does not
use IMAP/SMTP credentials, does not open mbox files directly, and never sends
mail.

## Features

- Reads accounts, identities, folders, messages, and full bodies through
  Thunderbird's own WebExtension APIs.
- Searches headers and bodies across folders with Thunderbird's message query.
- Creates drafts through Thunderbird, including To/Cc/Bcc, plain text, HTML,
  quoting, and base64 attachments.
- Sets `\Seen` / `\Answered` through Thunderbird so IMAP flags sync normally.
- Auto-detects local Thunderbird profiles for the bridge location.
- Runs as a stdio MCP server (default) or a local Streamable HTTP endpoint.

## Requirements

- Node.js 20 or newer
- Thunderbird 153 or newer, running with the `thunderbird-extension/` loaded
- A Thunderbird profile containing `prefs.js`

The extension is required for every mail operation. If Thunderbird is not
running or the extension is not loaded, the server returns an error instead of
falling back to files.

## Install and build

```bash
cd thunderbird-mcp
npm install
npm run build
```

Run the tests:

```bash
npm test
```

## Load the Thunderbird extension

1. Open Thunderbird.
2. Go to **Add-ons and Themes → Tools for all add-ons → Debug Add-ons**.
3. Choose **Load Temporary Add-on** and select
   `thunderbird-extension/manifest.json`.
4. Confirm the extension is enabled.

Temporary add-ons are removed when Thunderbird closes. For a permanent install,
package the extension as an `.xpi` and install it through Thunderbird's add-on
manager. See `thunderbird-extension/README.md` for details and
`thunderbird-extension/PRIVACY.md` for the privacy policy.

## Run

### stdio (default)

```bash
node dist/index.js
# or with an explicit profile:
node dist/index.js --profile ~/.thunderbird/xxxxxxxx.default-release
```

The server prints logs to stderr only, so stdout stays clean for MCP.

### Local HTTP endpoint

```bash
node dist/index.js --http --port 8765
```

- MCP endpoint: `POST http://127.0.0.1:8765/mcp`
- Health check: `GET http://127.0.0.1:8765/health`
- Bearer auth is required: send `Authorization: Bearer <token>`. The token
  defaults to the HTTP bearer password; override it with `--token` or
  `THUNDERBIRD_MCP_TOKEN`.

The HTTP transport uses stateful MCP sessions (`Mcp-Session-Id`). Bind to
`127.0.0.1` (the default) unless you have a reason not to.

Browser clients need two things:

- the header `Authorization: Bearer <bearer password>` (or the configured token)
- a CORS origin that is allowed. Localhost and 127.0.0.1 origins are allowed by
  default; use `--cors-origin` or `THUNDERBIRD_MCP_CORS_ORIGIN` for another
  origin. Preflight requests are answered without authentication.

For Chat AI, add a remote MCP server:

```json
{
  "type": "remote",
  "url": "http://127.0.0.1:8765/mcp",
  "headers": { "Authorization": "Bearer <bearer password>" }
}
```

Use a Chat AI page served over HTTP on localhost. An HTTPS page may block the
local HTTP MCP endpoint as mixed content.

## Options

| Option | Environment | Description |
| --- | --- | --- |
| `--profile <dir>` | `THUNDERBIRD_PROFILE` | Profile directory containing `prefs.js`. Auto-detected by default. |
| `--read-only` | `THUNDERBIRD_MCP_READ_ONLY=1` | Hide `create_draft`, `set_email_read`, `set_email_priority`, and `set_email_answered`. |
| `--debug` | `THUNDERBIRD_MCP_DEBUG=1` | Log every tool call, its arguments, and full error stacks to stderr. |
| `--transport <mode>` | `THUNDERBIRD_MCP_TRANSPORT` | `stdio` or `http`. |
| `--http` | | Shorthand for `--transport http`. |
| `--host <host>` | `THUNDERBIRD_MCP_HOST` | HTTP bind address, default `127.0.0.1`. |
| `--port <port>` | `THUNDERBIRD_MCP_PORT` | HTTP port, default `8765`. |
| `--password [password]` | `THUNDERBIRD_MCP_PASSWORD` | HTTP bearer password. Without a value, a native password prompt opens. |
| `--ask-password` | | Open a native password prompt at startup |
| `--token <token>` | `THUNDERBIRD_MCP_TOKEN` | HTTP bearer token; defaults to the HTTP bearer password. |
| `--cors-origin <list>` | `THUNDERBIRD_MCP_CORS_ORIGIN` | Comma-separated allowed browser origins; defaults to localhost/127.0.0.1. |

Profile auto-detection looks at:

- `~/.thunderbird`
- `~/snap/thunderbird/common/.thunderbird`
- `~/.var/app/org.mozilla.Thunderbird/.thunderbird`
- `~/.mozilla-thunderbird`

If several profiles exist, `profiles.ini` defaults are preferred. Use
`list_profiles` to see what was found, or set `THUNDERBIRD_PROFILE` to choose one.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_profiles` | Show discovered profiles and the selected one. |
| `list_accounts` | Show accounts, identities, and Drafts folders from Thunderbird. |
| `list_folders` | Show folders with types and message counts from Thunderbird. |
| `list_emails` | List message summaries with sender, subject, conversation, unread, and date-window filters. Summaries include a preview and salutation. |
| `read_email` | Read one message in full, with optional HTML and attachment metadata. |
| `search_emails` | Search headers and, by default, bodies across folders. |
| `create_draft` | Create a draft in Thunderbird. Never sends. Asks for native confirmation. With `inReplyTo`, quotes the original; `markReplied: true` asks separately to mark it answered. |
| `set_email_read` | Mark a message read or unread through Thunderbird. Asks for native confirmation. |
| `set_email_priority` | Set a message priority: `none`, `lowest`, `low`, `normal`, `high`, or `highest`. Asks for native confirmation. |
| `set_email_answered` | Mark a message answered/replied through Thunderbird. Asks for native confirmation. |
| `list_session_approvals` | Show mail access and actions the user allowed for this server session. |

### Authentication

Stdio mode has no transport authentication: any local process that can start
the server can use its tools.

HTTP mode requires `Authorization: Bearer <token>` on every request. The token
defaults to the HTTP bearer password, which is **`Zinnober`** unless changed
with `--password <password>`, `--ask-password` (native password prompt at
startup), or `THUNDERBIRD_MCP_PASSWORD`. Running `--password` without a value
also opens the prompt. Override the token itself with `--token` or
`THUNDERBIRD_MCP_TOKEN`. The password is never logged.

Typical flow:

1. `list_folders` or `list_emails` with `folder: "Inbox"`. The first call asks
   for native access approval.
2. `read_email` with the `id` returned by `list_emails`.
3. `create_draft` with `to`, `subject`, and `text` (and optionally `html`,
   `cc`, `bcc`, `attachments`).
4. `set_email_read` with an id from step 1 to mark it read or unread. The user
   confirms in a native dialog.

### Email cache

`read_email` writes the full message text to `cache/` as one file per message
(mode `0600`), with metadata in a JSON frontmatter block. Marking a message
unread via `set_email_read` deletes its cache file. Override the directory with
`THUNDERBIRD_MCP_CACHE_DIR`. `cache/` is git-ignored and contains confidential
mail content; never publish or share it.

## Filtering emails

`list_emails` and `search_emails` accept combinable filters (all conditions must
match). `search_emails` passes these directly to Thunderbird's native query
engine:

- `query` — Thunderbird `fullText`; may be empty when using field filters.
- `from` / `sender` — sender name or address.
- `recipients` — recipient name or address.
- `subject` / `title` — subject substring.
- `body` — body substring.
- `unreadOnly`, `flagged`, `hasAttachment`.
- `fromDate` / `toDate` — ISO 8601 or parseable dates.
- `tags` plus `tagMode` (`all`, `any`, `none`).
- `sizeMin` / `sizeMax` — message size in bytes.
- `conversation` — a `conversationId`, any message id in the thread, or a
  subject (optionally prefixed with `subject:`).

Each message summary contains `conversationId` and `conversationSize`.
Conversations use the normalized subject. Thunderbird's extension message
headers do not expose `References`/`In-Reply-To` directly, so subject grouping
is the primary fallback.

Example:

```json
{
  "folder": "INBOX",
  "from": "alice@example.com",
  "subject": "project",
  "unreadOnly": true,
  "conversation": "msg-1@example.com"
}
```

### Stable paging with dates

New mail changes `offset` paging. For repeatable batches, page with a date
window instead:

- use `toDate` to walk from newer to older mail; the next request uses the
  oldest `lastDate` from the previous response as its `toDate`
- use `fromDate` when you want everything since a known point
- combine either with `limit` and filters

The response echoes `fromDate`, `toDate`, and `lastDate`. `list_emails` also
returns a `preview`/`snippet` and a `salutation` for each summary, so triage can
often be done without opening the full message.

## Using it with opencode

Global config (`~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "servers": {
      "thunderbird": {
        "type": "local",
        "command": ["node", "/absolute/path/to/thunderbird-mcp/dist/index.js"]
      }
    }
  }
}
```

Or point at an HTTP instance:

```json
{
  "mcp": {
    "servers": {
      "thunderbird": {
        "type": "remote",
        "url": "http://127.0.0.1:8765/mcp",
        "headers": { "Authorization": "Bearer Zinnober" }
      }
    }
  }
}
```

Restart opencode after changing the config.

## Access and action confirmation

Before returning mailbox metadata or mail, the server asks the user in a native
dialog. `list_accounts` and `list_folders` share one metadata approval;
`list_emails`, `read_email`, and `search_emails` ask once for each mailbox they
access. Choosing **Allow for session** remembers that mailbox until the server
stops.

Every mutating tool then asks separately before doing anything:

- `create_draft`
- `set_email_read` (both read and unread)
- `set_email_priority`
- `set_email_answered`

The dialog offers **Allow for session**, **Allow once**, and **Deny**. Choosing
Allow for session remembers that action for the current mailbox or account
until the server stops; Allow once affects only that call. The dialog shows the
action, account, mailbox, and relevant message or draft details. Use
`list_session_approvals` to see what is currently approved.

The same native dialog implementation is used on Windows (PowerShell/Windows
Forms), macOS (`osascript`), and Linux (`zenity` or `kdialog`). The message area
scrolls, while all three buttons stay visible. The dialog waits 5 minutes by
default; set `THUNDERBIRD_MCP_DIALOG_TIMEOUT_MS` to change that.

If no native dialog can be shown, the action fails closed with an error.

## Draft safety

- Drafts are created by Thunderbird through the extension; the server does not
  write mbox or maildir files itself.
- The draft is stored in the account's configured Drafts folder. This server
  does not choose an arbitrary destination folder.
- `create_draft` never sends mail.
- With `inReplyTo`, the server quotes the original message and sets the
  threading headers. `markReplied: true` also asks the user to confirm marking
  the original as answered.

## Flag writes

`set_email_read`, `set_email_priority`, and `set_email_answered` use
Thunderbird's APIs through the extension, so Thunderbird performs the normal
IMAP sync. Each change asks for native confirmation and can be approved for the
session.

## Limitations

- Thunderbird must be running with the extension loaded for all mail tools.
- The server never sends, deletes, or moves mail. It can create drafts and set
  read/unread/answered flags.
- Extension message ids are session-scoped. Message ids returned by the server
  encode the folder plus the RFC Message-ID and/or extension id; re-list if an
  id goes stale.
- Search uses Thunderbird's `fullText` query plus server-side header filtering.
- Attachments are exposed as metadata when reading; draft attachments are
  accepted as base64.
- `list_profiles` still scans local profile directories to locate the bridge;
  it does not read mail files.
