# Windows installer for chromium-mcp, built on Linux

This folder cross-builds a Windows executable and NSIS installer for
`tools/chromium-mcp/` from Linux or macOS. The executable is a Node SEA binary
with the relay and `ws` bundled in. The installer also places the unpacked
Chromium extension next to the relay.

## Prerequisites

- Node.js 20 or newer.
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
npm --prefix tools/chromium-mcp install
bash build/windows/chromium-mcp/build-installer.sh
```

Or from the repository root:

```bash
npm run build:chromium:windows
```

Or build every Windows package this host supports:

```bash
make -C build/windows chromium
make -C build/windows
```

Artifacts are written to `build/windows/chromium-mcp/out/`:

| File | Purpose |
|---|---|
| `chromium-mcp.exe` | Standalone Windows relay executable (no Node.js needed) |
| `chromium-mcp-setup.exe` | Per-user NSIS installer |
| `chromium-mcp-windows.zip` | Portable ZIP with the exe, extension, and readme |
| `SHA256SUMS.txt` | Checksums for the generated artifacts |

## Options

| Variable | Meaning |
|---|---|
| `ZIP_ONLY=1` | Skip NSIS and build only the exe plus portable ZIP |
| `SKIP_TESTS=1` | Do not run the chromium-mcp tests first |
| `NODE_VERSION=22.22.1` | Build against a specific Node.js version |

## How it works

1. Runs the relay tests.
2. Downloads and checksum-verifies matching Linux and Windows Node.js runtimes.
3. Bundles `relay.mjs` and `ws` with esbuild into a CommonJS file. The bundle
   sets `MCP_SEA=1` so the relay starts without the ESM main-module check.
4. Generates the Node SEA blob with the downloaded Linux Node.js binary and
   injects it into the downloaded Windows `node.exe` with `postject`.
5. Copies the unpacked Chromium extension into the installer.
6. Compiles `installer.nsi` with `makensis`.
7. Runs a quick initialize smoke test against the bundle before packaging.

The installer is per-user (`%LOCALAPPDATA%\ChatAITools\ChromiumMCP`), needs no
administrator rights, and adds Start Menu shortcuts for the relay and the
extension folder.

## Notes and limitations

- The executable and installer are unsigned. `postject` prints a warning that
  the Node.js signature looks corrupted; that is expected after modifying the
  signed `node.exe`. Sign the output before broad distribution.
- The Chrome extension is not auto-installed. The installer includes the
  unpacked extension and the readme explains loading it from
  `chrome://extensions` with Developer mode. Auto-installing an unpacked
  extension silently would modify the browser profile and is avoided.
- Chrome/Chromium/Edge is not bundled; the target machine must provide it.
- The relay requires the extension to be connected before any browser tool can
  be used. Every tab access is confirmed in the browser.
