#!/usr/bin/env bash
# Cross-build a Windows executable and NSIS installer for calendar-mcp from Linux.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TOOL_DIR="$ROOT/tools/calendar-mcp"
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
  cat >&2 <<'MSG'
error: makensis is required to build the Windows installer.

Install NSIS on Debian/Ubuntu:
  sudo apt install nsis

Or build only the portable ZIP:
  ZIP_ONLY=1 ./build-installer.sh
MSG
  exit 1
fi

if [ ! -d "$ROOT/node_modules/esbuild" ] || [ ! -d "$ROOT/node_modules/postject" ]; then
  log "Installing root build dependencies..."
  (cd "$ROOT" && npm ci --no-audit --no-fund)
fi

if [ ! -d "$TOOL_DIR/node_modules/ical.js" ]; then
  log "Installing calendar-mcp dependencies..."
  (cd "$TOOL_DIR" && npm ci --no-audit --no-fund)
fi

if [ "$SKIP_TESTS" != "1" ]; then
  log "Running calendar-mcp tests..."
  (cd "$TOOL_DIR" && npm test)
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

log "Bundling calendar-mcp for Windows..."
"$ROOT/node_modules/.bin/esbuild" "$TOOL_DIR/server.mjs" \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node20 \
  --outfile="$OUT/calendar-mcp.cjs" \
  --banner:js="process.env.MCP_SEA='1';" \
  --log-level=warning \
  --log-override:empty-import-meta=silent

cat > "$OUT/sea-config.json" <<'JSON'
{
  "main": "calendar-mcp.cjs",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
JSON

log "Creating the SEA blob with Node.js ${NODE_VERSION}..."
(cd "$OUT" && "$LINUX_NODE" --experimental-sea-config sea-config.json)

log "Injecting the blob into node.exe..."
cp "$WIN_NODE" "$OUT/calendar-mcp.exe"
node "$ROOT/node_modules/postject/dist/cli.js" \
  "$OUT/calendar-mcp.exe" \
  NODE_SEA_BLOB \
  "$OUT/sea-prep.blob" \
  --sentinel-fuse "$SEA_FUSE"

cp "$ROOT/secrets/calendar.json.example" "$OUT/calendar.json.example"
cp "$SCRIPT_DIR/start-calendar-mcp.cmd" "$OUT/start-calendar-mcp.cmd"
cp "$SCRIPT_DIR/installer-readme.txt" "$OUT/installer-readme.txt"
cp "$SCRIPT_DIR/installer.nsi" "$OUT/installer.nsi"

cat > "$OUT/smoke-config.json" <<'JSON'
{
  "baseUrl": "http://127.0.0.1:9/dav/",
  "username": "smoke",
  "password": "smoke",
  "email": "smoke@example.com"
}
JSON

log "Checking the bundle..."
node - "$OUT/calendar-mcp.cjs" "$OUT/smoke-config.json" <<'NODE'
const { spawn } = require("node:child_process");
const child = spawn(
  process.execPath,
  [process.argv[2], "--config", process.argv[3]],
  { stdio: ["pipe", "pipe", "pipe"] },
);
let stdout = "";
let stderr = "";
let settled = false;
const finish = (ok) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  child.kill("SIGKILL");
  if (!ok) {
    process.stderr.write(stderr);
    process.exit(1);
  }
};
const timer = setTimeout(() => finish(false), 20000);
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  if (stdout.includes('"name":"calendar-mcp"')) finish(true);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.on("error", () => finish(false));
child.on("exit", () => {
  if (!settled) finish(stdout.includes('"name":"calendar-mcp"'));
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) +
    "\n",
);
NODE

if [ "$ZIP_ONLY" = "1" ]; then
  log "Skipping the installer (ZIP_ONLY=1)."
else
  log "Compiling the NSIS installer..."
  (cd "$OUT" && makensis -V2 installer.nsi)
fi

make_zip() {
  local dest="$1"
  shift
  if command -v zip >/dev/null 2>&1; then
    zip -q -9 "$dest" "$@"
    return
  fi
  command -v python3 >/dev/null 2>&1 || fail "zip or python3 is required to create archives."
  python3 - "$dest" "$@" <<'PY'
import os
import sys
import zipfile

dest = sys.argv[1]
with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for entry in sys.argv[2:]:
        archive.write(entry, os.path.basename(entry))
PY
}

log "Creating the portable ZIP..."
(cd "$OUT" && make_zip calendar-mcp-windows.zip \
  calendar-mcp.exe \
  calendar.json.example \
  start-calendar-mcp.cmd \
  installer-readme.txt)

rm -f "$OUT/calendar-mcp.cjs" "$OUT/sea-config.json" "$OUT/sea-prep.blob" \
  "$OUT/installer.nsi" "$OUT/smoke-config.json"
: > "$OUT/SHA256SUMS.txt"
for artifact in calendar-mcp.exe calendar-mcp-setup.exe calendar-mcp-windows.zip; do
  if [ -f "$OUT/$artifact" ]; then
    sha256sum "$OUT/$artifact" >> "$OUT/SHA256SUMS.txt"
  fi
done

log ""
log "Artifacts in $OUT:"
ls -lh "$OUT"
log ""
log "The executable and installer are unsigned. Sign them before distributing them widely."
