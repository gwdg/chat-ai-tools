# Windows build for local-folder-mcp

This folder builds the standalone Windows executable and Inno Setup installer
for `tools/local-folder-mcp/`.

Run the build on Windows, because `build-sea.mjs` copies the running `node.exe`:

```powershell
npm ci
npm run build:windows
```

Then compile the per-user installer with Inno Setup 6:

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" build\windows\local-folder-mcp\installer.iss
```

Artifacts are written to `build/windows/local-folder-mcp/out/`:

| File | Purpose |
|---|---|
| `local-folder-mcp.exe` | Standalone executable (no Node.js needed) |
| `local-folder-mcp-setup.exe` | Per-user Inno Setup installer |

Files:

- `build-sea.mjs` — esbuild bundle, Node SEA blob, and `postject` injection.
- `installer.iss` — Inno Setup script.
- `installer-readme.txt` — end-user guide included in the installation.

See the root [README-Windows.txt](../../../README-Windows.txt) for the complete
build, install, update, uninstall, and troubleshooting guide. The installer is
unsigned by default.
