SHELL := /bin/bash
.DEFAULT_GOAL := all

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
CHROMIUM_DIR := $(ROOT)/build/linux/chromium-mcp

.PHONY: help all chromium zip crx packages test clean

help:
	@echo "Usage: make -C build/linux <target> [CHROME=/path/to/chrome] [KEY=/path/to/key.pem]"
	@echo
	@echo "  all        Build the Chromium extension ZIP (default)"
	@echo "  chromium   Build the Chromium extension ZIP"
	@echo "  zip        Same as chromium"
	@echo "  crx        Build a signed CRX (key stored in chromium-mcp/.keys/)"
	@echo "  packages   Build both the ZIP and the CRX"
	@echo "  test       Validate and run the chromium-mcp relay tests"
	@echo "  clean      Remove Linux build outputs (keeps CRX keys)"
	@echo
	@echo "Each Linux-packaged tool has its own subfolder under build/linux/<tool>/."

all: chromium

chromium:
	@echo "==> chromium-mcp extension"
	@$(MAKE) --no-print-directory -C "$(CHROMIUM_DIR)" zip

zip: chromium

crx:
	@echo "==> chromium-mcp extension (CRX)"
	@$(MAKE) --no-print-directory -C "$(CHROMIUM_DIR)" crx

packages:
	@$(MAKE) --no-print-directory -C "$(CHROMIUM_DIR)" packages

test:
	@$(MAKE) --no-print-directory -C "$(CHROMIUM_DIR)" test

clean:
	@$(MAKE) --no-print-directory -C "$(CHROMIUM_DIR)" clean
	@echo "Removed Linux build outputs."
