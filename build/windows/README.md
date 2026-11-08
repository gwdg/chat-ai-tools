# Windows builds

Each Windows-packaged tool lives in its own subfolder:

| Folder | Tool | Build host |
|---|---|---|
| `local-folder-mcp/` | Local folder MCP server | Windows (Inno Setup) |
| `browser-mcp/` | Headless browser MCP server | Linux/macOS (NSIS) |
| `thunderbird-mcp/` | Thunderbird MCP server + extension | Linux/macOS (NSIS) |

The `Makefile` in this folder builds everything the current host supports.

## Build all

```bash
make -C build/windows
```

This runs `browser`, `thunderbird`, and `local-folder`. On Linux/macOS the
`local-folder` target is skipped with an explanation, because that build copies
the running `node.exe` and must run on Windows.

Individual targets:

```bash
make -C build/windows browser
make -C build/windows thunderbird
make -C build/windows local-folder
make -C build/windows clean
```

## Prerequisites

- Node.js 20 or newer and `npm`.
- `curl` and `tar` (used to download the matching Node.js runtimes).
- NSIS for `browser` and `thunderbird`:

  ```bash
  sudo apt install nsis        # Debian/Ubuntu
  sudo dnf install nsis        # Fedora
  ```

- Inno Setup 6 for `local-folder` on Windows. Set `ISCC` to the compiler path if
  `iscc` is not on `PATH`.

Without NSIS, build only the portable packages:

```bash
ZIP_ONLY=1 make -C build/windows browser thunderbird
```

## Options

| Variable | Meaning |
|---|---|
| `ZIP_ONLY=1` | Skip NSIS and build only the portable ZIPs |
| `SKIP_TESTS=1` | Skip the pre-build test suites |
| `NODE_VERSION=22.22.1` | Build against a specific Node.js version |
| `SKIP_LOCAL_FOLDER=1` | Do not run the Windows-only local-folder build |
| `ISCC=/path/to/ISCC.exe` | Inno Setup compiler for local-folder on Windows |

## Outputs

Artifacts are written under each tool's `out/` folder:

```text
build/windows/local-folder-mcp/out/
build/windows/browser-mcp/out/
build/windows/thunderbird-mcp/out/
```

All outputs are ignored by git. Executables and installers are unsigned by
default. See each tool's README for its artifacts, requirements, and signing
notes.
