SHELL := /bin/bash
.DEFAULT_GOAL := all

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
BROWSER_SCRIPT := $(ROOT)/build/windows/browser-mcp/build-installer.sh
THUNDERBIRD_SCRIPT := $(ROOT)/build/windows/thunderbird-mcp/build-installer.sh

ZIP_ONLY ?= 0
SKIP_TESTS ?= 0
SKIP_LOCAL_FOLDER ?= 0
NODE_VERSION ?=
WINDOWS_BUILD_CACHE ?= $(ROOT)/build/windows/.cache

export ZIP_ONLY SKIP_TESTS NODE_VERSION WINDOWS_BUILD_CACHE

.PHONY: help all browser thunderbird local-folder clean

help:
	@echo "Usage: make -C build/windows <target> [ZIP_ONLY=1] [SKIP_TESTS=1] [NODE_VERSION=22.22.1]"
	@echo
	@echo "  all            Build every Windows package that this host can build (default)"
	@echo "  browser        Build browser-mcp exe, NSIS installer, and portable ZIP"
	@echo "  thunderbird    Build thunderbird-mcp exe, NSIS installer, extension XPI, and ZIP"
	@echo "  local-folder   Build local-folder-mcp on Windows (skipped elsewhere)"
	@echo "  clean          Remove all build outputs and downloaded runtimes"
	@echo
	@echo "browser and thunderbird cross-build on Linux and require makensis (NSIS)."
	@echo "local-folder copies the running node.exe and must run on Windows with Inno Setup."
	@echo "Set SKIP_LOCAL_FOLDER=1 to omit it even on Windows."

all: browser thunderbird local-folder

browser:
	@echo "==> browser-mcp"
	@bash "$(BROWSER_SCRIPT)"

thunderbird:
	@echo "==> thunderbird-mcp"
	@bash "$(THUNDERBIRD_SCRIPT)"

local-folder:
	@if [ "$(SKIP_LOCAL_FOLDER)" = "1" ]; then \
		echo "==> local-folder-mcp: skipped (SKIP_LOCAL_FOLDER=1)"; \
	elif [ "$$OS" != "Windows_NT" ]; then \
		echo "==> local-folder-mcp: skipped"; \
		echo "    This build copies the running node.exe and must run on Windows."; \
		echo "    Run 'npm run build:windows' on Windows or use the GitHub Actions workflow."; \
	else \
		echo "==> local-folder-mcp"; \
		cd "$(ROOT)" && npm run build:windows || exit 1; \
		iscc="$${ISCC:-}"; \
		if [ -z "$$iscc" ] && command -v iscc >/dev/null 2>&1; then \
			iscc="iscc"; \
		fi; \
		if [ -z "$$iscc" ] && [ -x "/c/Program Files (x86)/Inno Setup 6/ISCC.exe" ]; then \
			iscc="/c/Program Files (x86)/Inno Setup 6/ISCC.exe"; \
		fi; \
		if [ -z "$$iscc" ]; then \
			echo "error: Inno Setup ISCC.exe not found." >&2; \
			echo "Install Inno Setup 6, or set ISCC to the ISCC.exe path." >&2; \
			echo "The standalone executable was built in build/windows/local-folder-mcp/out/." >&2; \
			exit 1; \
		fi; \
		(cd "$(ROOT)/build/windows/local-folder-mcp" && "$$iscc" installer.iss); \
	fi

clean:
	@rm -rf \
		"$(ROOT)/build/windows/local-folder-mcp/out" \
		"$(ROOT)/build/windows/browser-mcp/out" \
		"$(ROOT)/build/windows/browser-mcp/.cache" \
		"$(ROOT)/build/windows/thunderbird-mcp/out" \
		"$(ROOT)/build/windows/thunderbird-mcp/.cache" \
		"$(ROOT)/build/windows/.cache"
	@echo "Removed Windows build outputs."
