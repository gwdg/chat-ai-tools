# Windows installer for calendar-mcp, built on Linux

This folder cross-builds a Windows executable and NSIS installer for
`tools/calendar-mcp/` from Linux or macOS. The executable is a Node SEA binary
with the calendar server and its CalDAV/iCalendar dependencies bundled in.

## Prerequisites

- Node.js 20 or newer.
- `curl`, `tar`, and root `npm` dependencies.
- `makensis` from NSIS:

  ```bash
  sudo apt install nsis
  ```

  Without NSIS, use `ZIP_ONLY=1`.

## Build

```bash
npm install
npm --prefix tools/calendar-mcp install
bash build/windows/calendar-mcp/build-installer.sh
```

Or from the repository root:

```bash
npm run build:calendar:windows
make -C build/windows calendar
```

Artifacts in `build/windows/calendar-mcp/out/`:

| File | Purpose |
|---|---|
| `calendar-mcp.exe` | Standalone Windows executable |
| `calendar-mcp-setup.exe` | Per-user NSIS installer |
| `calendar-mcp-windows.zip` | Portable ZIP |
| `calendar.json.example` | Configuration template |
| `SHA256SUMS.txt` | Checksums |

## Options

| Variable | Meaning |
|---|---|
| `ZIP_ONLY=1` | Skip NSIS |
| `SKIP_TESTS=1` | Skip the pre-build tests |
| `NODE_VERSION=22.22.1` | Build against a specific Node.js version |

## Notes

- The executable and installer are unsigned; `postject` invalidates the Node.js
  signature. Sign them before broad distribution.
- No CalDAV server is bundled. The target machine must be able to reach yours
  over HTTPS.
- The installer includes `calendar.json.example` but does not create or copy a
  real `calendar.json`; the user must create it with their app password.
- The launcher starts `calendar-mcp.exe --http --config calendar.json` on
  `127.0.0.1:8767`.
