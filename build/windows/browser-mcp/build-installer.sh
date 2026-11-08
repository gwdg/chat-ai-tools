#!/usr/bin/env bash
# Cross-build a Windows executable and NSIS installer for browser-mcp from Linux.
# The executable is a Node SEA binary; the installer is compiled by makensis.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TOOL_DIR="$ROOT/tools/browser-mcp"
OUT="$SCRIPT_DIR/out"
CACHE="${WINDOWS_BUILD_CACHE:-$SCRIPT_DIR/.cache}"

NODE_VERSION="${NODE_VERSION:-$(node -p 'process.version.slice(1)')}"
NODE_VERSION="${NODE_VERSION#v}"
ZIP_ONLY="${ZIP_ONLY:-0}"
SKIP_TESTS="${SKIP_TESTS:-0}"
SEA_FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

log() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."

if [ "$ZIP_ONLY" != "1" ] && ! command -v makensis >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: makensis is required to build the Windows installer.

Install NSIS on Debian/Ubuntu:
  sudo apt install nsis

Or build only the portable ZIP:
  ZIP_ONLY=1 ./build-installer.sh
EOF
  exit 1
fi

if [ ! -d "$ROOT/node_modules/esbuild" ] || [ ! -d "$ROOT/node_modules/postject" ]; then
  log "Installing root build dependencies..."
  (cd "$ROOT" && npm ci --no-audit --no-fund)
fi

if [ ! -d "$TOOL_DIR/node_modules/puppeteer-core" ]; then
  log "Installing browser-mcp dependencies..."
  (cd "$TOOL_DIR" && npm ci --no-audit --no-fund)
fi

if [ "$SKIP_TESTS" != "1" ]; then
  log "Running browser-mcp tests..."
  node --test "$ROOT/tests/browser-mcp.test.mjs"
fi

rm -rf "$OUT"
mkdir -p "$OUT" "$CACHE"

WIN_NODE="$CACHE/node-v${NODE_VERSION}-win-x64.exe"
LINUX_TAR="$CACHE/node-v${NODE_VERSION}-linux-x64.tar.gz"
LINUX_NODE="$CACHE/node-v${NODE_VERSION}-linux-x64/bin/node"
SHASUMS="$CACHE/SHASUMS256-${NODE_VERSION}.txt"
BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"

if [ ! -f "$SHASUMS" ]; then
  log "Fetching Node.js ${NODE_VERSION} checksums..."
  curl -fsSL --retry 3 "$BASE_URL/SHASUMS256.txt" -o "$SHASUMS"
fi

download() {
  local url="$1" dest="$2" label="$3"
  if [ -f "$dest" ]; then
    log "Using cached $label."
    return
  fi
  log "Downloading $label..."
  curl -fL --retry 3 --progress-bar "$url" -o "$dest.tmp"
  mv "$dest.tmp" "$dest"
}

verify() {
  local file="$1" name="$2"
  local expected actual
  expected="$(grep -E "  ${name}$" "$SHASUMS" | awk '{print $1}' | head -n1)"
  [ -n "$expected" ] || fail "No checksum for $name in SHASUMS256.txt."
  actual="$(sha256sum "$file" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || fail "Checksum mismatch for $name."
}

download "$BASE_URL/win-x64/node.exe" "$WIN_NODE" "Windows Node.js ${NODE_VERSION}"
verify "$WIN_NODE" "win-x64/node.exe"

download "$BASE_URL/node-v${NODE_VERSION}-linux-x64.tar.gz" "$LINUX_TAR" "Linux Node.js ${NODE_VERSION} (for SEA blob)"
verify "$LINUX_TAR" "node-v${NODE_VERSION}-linux-x64.tar.gz"

if [ ! -x "$LINUX_NODE" ]; then
  log "Extracting the matching Linux Node.js runtime..."
  tar -xzf "$LINUX_TAR" -C "$CACHE" "node-v${NODE_VERSION}-linux-x64/bin/node"
  chmod +x "$LINUX_NODE"
fi

log "Bundling browser-mcp for Windows..."
"$ROOT/node_modules/.bin/esbuild" "$TOOL_DIR/server.mjs" \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node20 \
  --outfile="$OUT/browser-mcp.cjs" \
  --banner:js="process.env.MCP_SEA='1';" \
  --log-level=warning \
  --log-override:empty-import-meta=silent

cat > "$OUT/sea-config.json" <<'JSON'
{
  "main": "browser-mcp.cjs",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
JSON

log "Creating the SEA blob with Node.js ${NODE_VERSION}..."
(cd "$OUT" && "$LINUX_NODE" --experimental-sea-config sea-config.json)

log "Injecting the blob into node.exe..."
cp "$WIN_NODE" "$OUT/browser-mcp.exe"
node "$ROOT/node_modules/postject/dist/cli.js" \
  "$OUT/browser-mcp.exe" \
  NODE_SEA_BLOB \
  "$OUT/sea-prep.blob" \
  --sentinel-fuse "$SEA_FUSE"

log "Checking the bundle..."
SMOKE_OUT="$OUT/.smoke.out"
SMOKE_ERR="$OUT/.smoke.err"
if ! printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  | timeout 20 node "$OUT/browser-mcp.cjs" >"$SMOKE_OUT" 2>"$SMOKE_ERR"; then
  cat "$SMOKE_ERR" >&2
  fail "The bundled server failed its initialize smoke test."
fi
grep -q '"name":"browser-mcp"' "$SMOKE_OUT" \
  || fail "The bundled server did not identify itself as browser-mcp."
rm -f "$SMOKE_OUT" "$SMOKE_ERR"

cp "$SCRIPT_DIR/installer-readme.txt" "$OUT/installer-readme.txt"
cp "$SCRIPT_DIR/installer.nsi" "$OUT/installer.nsi"

if [ "$ZIP_ONLY" = "1" ]; then
  log "Skipping the installer (ZIP_ONLY=1)."
else
  log "Compiling the NSIS installer..."
  (cd "$OUT" && makensis -V2 installer.nsi)
fi

if command -v zip >/dev/null 2>&1; then
  (cd "$OUT" && zip -q -9 browser-mcp-windows.zip browser-mcp.exe installer-readme.txt)
elif command -v python3 >/dev/null 2>&1; then
  (cd "$OUT" && python3 -m zipfile -c browser-mcp-windows.zip browser-mcp.exe installer-readme.txt)
else
  log "warning: neither zip nor python3 is available; skipping the portable ZIP."
fi

rm -f "$OUT/browser-mcp.cjs" "$OUT/sea-config.json" "$OUT/sea-prep.blob" "$OUT/installer.nsi"
: > "$OUT/SHA256SUMS.txt"
for artifact in browser-mcp.exe browser-mcp-setup.exe browser-mcp-windows.zip; do
  if [ -f "$OUT/$artifact" ]; then
    sha256sum "$OUT/$artifact" >> "$OUT/SHA256SUMS.txt"
  fi
done

log ""
log "Artifacts in $OUT:"
ls -lh "$OUT"
log ""
log "The executable and installer are unsigned. Sign them before distributing them widely."
