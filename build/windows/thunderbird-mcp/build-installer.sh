#!/usr/bin/env bash
# Cross-build a Windows executable and NSIS installer for thunderbird-mcp from Linux.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TOOL_DIR="$ROOT/tools/thunderbird-mcp"
EXT_SRC="$TOOL_DIR/thunderbird-extension"
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

if [ ! -d "$TOOL_DIR/node_modules" ]; then
  log "Installing thunderbird-mcp dependencies..."
  (cd "$TOOL_DIR" && npm ci --no-audit --no-fund)
fi

log "Building thunderbird-mcp TypeScript..."
(cd "$TOOL_DIR" && npm run build)

if [ "$SKIP_TESTS" != "1" ]; then
  log "Running thunderbird-mcp tests..."
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

log "Bundling thunderbird-mcp for Windows..."
"$ROOT/node_modules/.bin/esbuild" "$TOOL_DIR/dist/index.js" \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node20 \
  --outfile="$OUT/thunderbird-mcp.cjs" \
  --log-level=warning \
  --log-override:empty-import-meta=silent

cat > "$OUT/sea-config.json" <<'JSON'
{
  "main": "thunderbird-mcp.cjs",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
JSON

log "Creating the SEA blob with Node.js ${NODE_VERSION}..."
(cd "$OUT" && "$LINUX_NODE" --experimental-sea-config sea-config.json)

log "Injecting the blob into node.exe..."
cp "$WIN_NODE" "$OUT/thunderbird-mcp.exe"
node "$ROOT/node_modules/postject/dist/cli.js" \
  "$OUT/thunderbird-mcp.exe" \
  NODE_SEA_BLOB \
  "$OUT/sea-prep.blob" \
  --sentinel-fuse "$SEA_FUSE"

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
        if os.path.isdir(entry):
            for dirpath, _, filenames in os.walk(entry):
                for filename in filenames:
                    full = os.path.join(dirpath, filename)
                    archive.write(full, os.path.relpath(full, "."))
        else:
            archive.write(entry, entry)
PY
}

log "Packaging the Thunderbird extension..."
(cd "$EXT_SRC" && make_zip "$OUT/thunderbird-mcp-extension.xpi" manifest.json background.js experiments PRIVACY.md)
mkdir -p "$OUT/extension"
cp -R "$EXT_SRC/." "$OUT/extension/"
rm -f "$OUT/extension/test-client.js"

cp "$SCRIPT_DIR/start-thunderbird-mcp.cmd" "$OUT/start-thunderbird-mcp.cmd"
cp "$SCRIPT_DIR/installer-readme.txt" "$OUT/installer-readme.txt"
cp "$SCRIPT_DIR/installer.nsi" "$OUT/installer.nsi"

log "Checking the bundle..."
node - "$OUT/thunderbird-mcp.cjs" <<'NODE'
const { spawn } = require("node:child_process");

const entry = process.argv[2];
const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
});
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
  if (stdout.includes('"name":"thunderbird-mcp"')) finish(true);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.on("error", () => finish(false));
child.on("exit", () => {
  if (!settled) finish(stdout.includes('"name":"thunderbird-mcp"'));
});
child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "build-smoke-test", version: "0.0.0" },
    },
  }) + "\n",
);
NODE

if [ "$ZIP_ONLY" = "1" ]; then
  log "Skipping the installer (ZIP_ONLY=1)."
else
  log "Compiling the NSIS installer..."
  (cd "$OUT" && makensis -V2 installer.nsi)
fi

log "Creating the portable ZIP..."
(cd "$OUT" && make_zip thunderbird-mcp-windows.zip \
  thunderbird-mcp.exe \
  thunderbird-mcp-extension.xpi \
  start-thunderbird-mcp.cmd \
  installer-readme.txt \
  extension)

rm -f "$OUT/thunderbird-mcp.cjs" "$OUT/sea-config.json" "$OUT/sea-prep.blob" "$OUT/installer.nsi"
: > "$OUT/SHA256SUMS.txt"
for artifact in thunderbird-mcp.exe thunderbird-mcp-setup.exe thunderbird-mcp-windows.zip; do
  if [ -f "$OUT/$artifact" ]; then
    sha256sum "$OUT/$artifact" >> "$OUT/SHA256SUMS.txt"
  fi
done

log ""
log "Artifacts in $OUT:"
ls -lh "$OUT"
log ""
log "The executable and installer are unsigned. Sign them before distributing them widely."
log "The Thunderbird extension is included but must be loaded or installed in Thunderbird."
