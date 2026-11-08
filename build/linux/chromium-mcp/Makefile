SHELL := /bin/bash
.DEFAULT_GOAL := all

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../../..)
EXT_SRC := $(ROOT)/tools/chromium-mcp/extension
OUT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))/out
STAGE := $(OUT)/extension
KEYS := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))/.keys
KEY ?= $(KEYS)/chromium-mcp.pem

CHROME ?= $(shell command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || command -v microsoft-edge 2>/dev/null || true)
CHROME_FLAGS ?= --no-sandbox

ZIP_NAME := chromium-mcp-extension.zip
CRX_NAME := chromium-mcp-extension.crx

.PHONY: help all packages zip crx stage validate test checksums clean

help:
	@echo "Usage: make -C build/linux/chromium-mcp <target> [CHROME=/path/to/chrome] [KEY=/path/to/key.pem]"
	@echo
	@echo "  all        Validate and build the extension ZIP (default)"
	@echo "  zip        Build build/linux/chromium-mcp/out/$(ZIP_NAME)"
	@echo "  crx        Build a signed CRX and reusable key"
	@echo "  packages   Build both the ZIP and the CRX"
	@echo "  validate   Validate manifest.json and JavaScript syntax"
	@echo "  test       Validate, then run the chromium-mcp relay tests"
	@echo "  clean      Remove build outputs (keeps .keys/)"
	@echo
	@echo "The generated key is stored in build/linux/chromium-mcp/.keys/ and must stay private."
	@echo "Chrome auto-detected as: $(CHROME)"
	@echo "Note: off-store CRX installation can be blocked by enterprise policy."

all: zip

packages: zip crx

validate:
	@node -e 'JSON.parse(require("node:fs").readFileSync("$(EXT_SRC)/manifest.json", "utf8"))'
	@for file in "$(EXT_SRC)"/*.js; do node --check "$$file"; done
	@echo "Extension manifest and scripts are valid."

test: validate
	@cd "$(ROOT)/tools/chromium-mcp" && npm test

stage: validate
	@rm -rf "$(STAGE)"
	@mkdir -p "$(STAGE)"
	@cp -R "$(EXT_SRC)/." "$(STAGE)/"
	@rm -rf "$(STAGE)/node_modules" "$(STAGE)/.DS_Store"

zip: stage
	@mkdir -p "$(OUT)"
	@if command -v zip >/dev/null 2>&1; then \
		(cd "$(STAGE)" && zip -qr -X "$(OUT)/$(ZIP_NAME)" .); \
	else \
		command -v python3 >/dev/null 2>&1 || { echo "error: zip or python3 is required." >&2; exit 1; }; \
		(cd "$(STAGE)" && python3 -c 'import pathlib, sys, zipfile; root = pathlib.Path(".").resolve(); out = sys.argv[1]; archive = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED); [archive.write(path, path.relative_to(root)) for path in root.rglob("*") if path.is_file()]; archive.close()' "$(OUT)/$(ZIP_NAME)"); \
	fi
	@$(MAKE) --no-print-directory checksums
	@echo "Built $(OUT)/$(ZIP_NAME)"

crx: stage
	@test -n "$(CHROME)" || { echo "error: Chrome/Chromium/Edge not found. Set CHROME=/path/to/binary." >&2; exit 1; }
	@mkdir -p "$(KEYS)" "$(OUT)"
	@chmod 700 "$(KEYS)" 2>/dev/null || true
	@if [ -f "$(KEY)" ]; then \
		"$(CHROME)" $(CHROME_FLAGS) --pack-extension="$(STAGE)" --pack-extension-key="$(KEY)"; \
	else \
		(umask 077; "$(CHROME)" $(CHROME_FLAGS) --pack-extension="$(STAGE)"); \
		if [ -f "$(OUT)/extension.pem" ]; then \
			mv "$(OUT)/extension.pem" "$(KEY)"; \
			chmod 600 "$(KEY)"; \
			echo "Generated and saved CRX key: $(KEY)"; \
		fi; \
	fi
	@test -f "$(OUT)/extension.crx" || { echo "error: Chrome did not create extension.crx." >&2; exit 1; }
	@mv -f "$(OUT)/extension.crx" "$(OUT)/$(CRX_NAME)"
	@$(MAKE) --no-print-directory checksums
	@echo "Built $(OUT)/$(CRX_NAME)"

checksums:
	@mkdir -p "$(OUT)"
	@cd "$(OUT)" && { \
		for file in "$(ZIP_NAME)" "$(CRX_NAME)"; do \
			if [ -f "$$file" ]; then sha256sum "$$file"; fi; \
		done; \
	} > SHA256SUMS.txt

clean:
	@rm -rf "$(OUT)"
	@echo "Removed $(OUT). The CRX key in $(KEYS) was kept."
