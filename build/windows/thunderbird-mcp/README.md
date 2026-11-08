# Windows installer for thunderbird-mcp, built on Linux

This folder cross-builds a Windows executable and NSIS installer for
`tools/thunderbird-mcp/` from Linux or macOS. The executable is a Node SEA
binary with the server dependencies bundled in. The installer also includes the
privileged Thunderbird extension (as an `.xpi` and as an unpacked folder) and a
launcher that generates a random Bearer token.

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
npm --prefix tools/thunderbird-mcp install
bash build/windows/thunderbird-mcp/build-installer.sh
```

Or from the repository root:

```bash
npm run build:thunderbird:windows
```

Artifacts are written to `build/windows/thunderbird-mcp/out/`:

| File | Purpose |
|---|---|
| `thunderbird-mcp.exe` | Standalone Windows executable (no Node.js needed) |
| `thunderbird-mcp-setup.exe` | Per-user NSIS installer |
| `thunderbird-mcp-windows.zip` | Portable ZIP with the exe, XPI, launcher, readme, and extension folder |
| `thunderbird-mcp-extension.xpi` | Installable Thunderbird extension |
| `SHA256SUMS.txt` | Checksums for the generated artifacts |

## Options

| Variable | Meaning |
|---|---|
| `ZIP_ONLY=1` | Skip NSIS and build only the exe plus portable ZIP |
| `SKIP_TESTS=1` | Do not run the thunderbird-mcp tests first |
| `NODE_VERSION=22.22.1` | Build against a specific Node.js version |

## How it works

1. Builds the TypeScript server (`npm run build`) and runs its tests.
2. Downloads and checksum-verifies matching Linux and Windows Node.js runtimes.
3. Bundles `dist/index.js` and its dependencies with esbuild into a CommonJS
   file.
4. Generates the Node SEA blob with the downloaded Linux Node.js binary and
   injects it into the downloaded Windows `node.exe` with `postject`.
5. Packages the Thunderbird extension as an XPI and as an unpacked folder.
6. Compiles `installer.nsi` with `makensis`.
7. Runs a quick initialize smoke test against the bundle before packaging.

The installer is per-user (`%LOCALAPPDATA%\ChatAITools\ThunderbirdMCP`), needs no
administrator rights, and adds Start Menu shortcuts for the server launcher, the
extension folder, and uninstall.

## Notes and limitations

- The executable and installer are unsigned. `postject` prints a warning that
  the Node.js signature looks corrupted; that is expected after modifying the
  signed `node.exe`. Sign the output before broad distribution.
- The Thunderbird extension is privileged (Experiment API) and is not
  auto-installed. The installer includes it and the readme explains temporary
  and permanent loading. Users must confirm the extension in Thunderbird.
- The launcher generates a random bearer token on first run and stores it in
  `token.txt` next to the executable. Chat AI needs that token in the
  `Authorization` header.
- Windows profile detection uses `%APPDATA%\Thunderbird\profiles.ini`;
  `THUNDERBIRD_PROFILE` overrides it when needed.
- The file bridge is used on Windows; the optional Unix socket transport is
  Linux/macOS-specific.
