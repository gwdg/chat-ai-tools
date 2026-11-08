# Linux builds

Each Linux-packaged tool lives in its own subfolder:

| Folder | Tool | Artifacts |
|---|---|---|
| `chromium-mcp/` | Chromium browser-control extension | Web Store ZIP, optional signed CRX |

The `Makefile` in this folder builds every package.

## Build all

```bash
make -C build/linux
```

This runs `chromium`, which builds the Chromium extension ZIP.

Individual targets:

```bash
make -C build/linux chromium
make -C build/linux zip
make -C build/linux crx
make -C build/linux packages
make -C build/linux test
make -C build/linux clean
```

## Prerequisites

- Node.js 20 or newer.
- `zip` or `python3` for the ZIP.
- Chrome, Chromium, or Microsoft Edge for the optional CRX.
- `make` and `bash`.

## Options

| Variable | Meaning |
|---|---|
| `CHROME=/path/to/chrome` | Browser used to pack the CRX |
| `CHROME_FLAGS=` | Override packaging flags (default `--no-sandbox`) |
| `KEY=/path/to/key.pem` | Reuse a specific CRX signing key |

## Outputs

```text
build/linux/chromium-mcp/out/chromium-mcp-extension.zip
build/linux/chromium-mcp/out/chromium-mcp-extension.crx
build/linux/chromium-mcp/out/SHA256SUMS.txt
```

The CRX signing key is stored in `build/linux/chromium-mcp/.keys/` and is
ignored by git. Keep it private and reuse it for updates. `make clean` removes
`out/` but keeps `.keys/`.

See [chromium-mcp/README.md](chromium-mcp/README.md) for details.

The relay itself needs no Linux build. Run it with `npm run mcp:chromium`.
Windows executables and installers are under `build/windows/`.
