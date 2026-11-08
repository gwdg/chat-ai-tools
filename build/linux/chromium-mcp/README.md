# Chromium extension packaging

The Chromium extension is plain Manifest V3 HTML/JS/CSS, so there is no compile
step. This folder contains a Makefile that validates it and produces the
distribution packages.

## Build the Web Store ZIP

```bash
make -C build/linux/chromium-mcp
# or
make -C build/linux/chromium-mcp zip
```

Output:

```text
build/linux/chromium-mcp/out/chromium-mcp-extension.zip
build/linux/chromium-mcp/out/SHA256SUMS.txt
```

The ZIP has `manifest.json` at the root and can be uploaded to the Chrome Web
Store or served for unpacked installation.

## Build a signed CRX

```bash
make -C build/linux/chromium-mcp crx
```

Chrome or Chromium is auto-detected. Override it with:

```bash
make -C build/linux/chromium-mcp crx CHROME=/usr/bin/chromium
```

On the first run without a key, Chrome generates one and the Makefile stores it
in:

```text
build/linux/chromium-mcp/.keys/chromium-mcp.pem
```

Keep that file private and reuse it for every update so the extension ID stays
the same. To use an existing key:

```bash
make -C build/linux/chromium-mcp crx KEY=/path/to/chromium-mcp.pem
```

Output:

```text
build/linux/chromium-mcp/out/chromium-mcp-extension.crx
```

Chrome restricts installing CRX files outside the Web Store. For local use,
load the unpacked `tools/chromium-mcp/extension/` folder from
`chrome://extensions` instead.

## Other targets

```bash
make -C build/linux/chromium-mcp validate   # manifest JSON + JS syntax
make -C build/linux/chromium-mcp test       # validate + chromium-mcp relay tests
make -C build/linux/chromium-mcp packages   # ZIP and CRX
make -C build/linux/chromium-mcp clean      # remove out/, keep .keys/
```

## Notes

- `build/linux/chromium-mcp/out/` and `build/linux/chromium-mcp/.keys/` are ignored by git. Never commit
  the generated `.pem` key.
- The Makefile uses `--no-sandbox` for the packaging Chrome process by default,
  which is useful in containers. Override with `CHROME_FLAGS=` on a normal
  desktop.
- The relay itself needs no Linux build. Run it with `npm run mcp:chromium`.
- Windows executables and the NSIS installer are under `build/windows/`.
