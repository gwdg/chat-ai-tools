# Windows installer for browser-mcp, built on Linux

This folder cross-builds a Windows executable and NSIS installer for
`tools/browser-mcp/` from Linux or macOS. The executable is a Node SEA binary
with `puppeteer-core` bundled in; the target machine still needs Chrome,
Chromium, or Microsoft Edge.

## Prerequisites

- Node.js 20 or newer (the script downloads matching Linux and Windows Node
  runtimes for the SEA blob).
- `curl`, `tar`, and root `npm` dependencies (`npm install` in the repository
  root).
- `makensis` from NSIS for the installer:

  ```bash
  sudo apt install nsis        # Debian/Ubuntu
  sudo dnf install nsis        # Fedora
  ```

  Without NSIS you can still build the portable ZIP with `ZIP_ONLY=1`.

## Build

```bash
npm install
npm --prefix tools/browser-mcp install
bash build/windows/browser-mcp/build-installer.sh
```

Or from the repository root:

```bash
npm run build:browser:windows
```

Artifacts are written to `build/windows/browser-mcp/out/`:

| File | Purpose |
|---|---|
| `browser-mcp.exe` | Standalone Windows executable (no Node.js needed) |
| `browser-mcp-setup.exe` | Per-user NSIS installer |
| `browser-mcp-windows.zip` | Portable ZIP with the exe and readme |
| `SHA256SUMS.txt` | Checksums for the generated artifacts |

## Options

| Variable | Meaning |
|---|---|
| `ZIP_ONLY=1` | Skip NSIS and build only the exe plus portable ZIP |
| `SKIP_TESTS=1` | Do not run `tests/browser-mcp.test.mjs` first |
| `NODE_VERSION=22.22.1` | Build against a specific Node.js version |

Example:

```bash
ZIP_ONLY=1 SKIP_TESTS=1 bash build/windows/browser-mcp/build-installer.sh
```

## How it works

1. Downloads the matching Linux and Windows Node.js runtimes from nodejs.org
   and verifies their SHA-256 checksums.
2. Bundles `tools/browser-mcp/server.mjs` and `puppeteer-core` into a CommonJS
   file with esbuild. The bundle sets `MCP_SEA=1` so the server starts without
   the usual module-entry check.
3. Generates the Node SEA blob with the downloaded Linux Node.js binary and
   injects it into the downloaded Windows `node.exe` with `postject`.
4. Compiles `installer.nsi` with `makensis`.
5. Runs a quick initialize smoke test against the bundle before packaging.

The installer is per-user (`%LOCALAPPDATA%\ChatAITools\BrowserMCP`), needs no
administrator rights, and adds a Start Menu shortcut that runs `--http`.

## Notes and limitations

- The executable and installer are unsigned. `postject` prints a warning that
  the Node.js signature looks corrupted; that is expected after modifying the
  signed `node.exe`. Sign the output with an organization certificate before
  broad distribution to avoid SmartScreen warnings.
- Chrome/Chromium/Edge is not bundled. Set `BROWSER_MCP_CHROME_PATH` on the
  target if detection fails.
- The installer does not configure environment variables. Users who want a
  token, custom port, or host allowlist set them with `setx` as described in
  `installer-readme.txt`.
- Cross-building relies on `postject` being able to patch a PE file from Linux.
  If your environment restricts this, run the same script on Windows or use the
  existing GitHub Actions pattern.
