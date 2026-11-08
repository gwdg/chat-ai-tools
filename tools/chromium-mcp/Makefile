SHELL := /bin/bash
.DEFAULT_GOAL := start

NODE ?= node
NPM ?= npm
HOST ?= 127.0.0.1
PORT ?= 8766
MCP_TOKEN ?=
EXTENSION_TOKEN ?=
CORS_ORIGIN ?=
COMMAND_TIMEOUT ?= 180000

ENTRY := $(CURDIR)/relay.mjs
PIDFILE := $(CURDIR)/.chromium-mcp.pid
HEALTH_HOST := $(if $(filter ::1 [::1],$(HOST)),[::1],$(HOST))

RUN_ENV := HOST="$(HOST)" MCP_CHROMIUM_HTTP_PORT="$(PORT)" \
	MCP_CHROMIUM_COMMAND_TIMEOUT_MS="$(COMMAND_TIMEOUT)"
STDIO_ENV := HOST="$(HOST)" MCP_CHROMIUM_EXTENSION_PORT="$(PORT)" \
	MCP_CHROMIUM_COMMAND_TIMEOUT_MS="$(COMMAND_TIMEOUT)"
ifneq ($(CORS_ORIGIN),)
RUN_ENV += MCP_CHROMIUM_CORS_ORIGIN="$(CORS_ORIGIN)"
endif
ifneq ($(MCP_TOKEN),)
RUN_ENV += MCP_CHROMIUM_TOKEN="$(MCP_TOKEN)"
endif
ifneq ($(EXTENSION_TOKEN),)
RUN_ENV += MCP_CHROMIUM_EXTENSION_TOKEN="$(EXTENSION_TOKEN)"
STDIO_ENV += MCP_CHROMIUM_EXTENSION_TOKEN="$(EXTENSION_TOKEN)"
endif

.PHONY: help deps start stop restart status install test stdio clean

help:
	@echo "Usage: make <target> [PORT=8766] [HOST=127.0.0.1]"
	@echo "                      [MCP_TOKEN=secret] [EXTENSION_TOKEN=secret]"
	@echo "                      [CORS_ORIGIN=http://localhost:8080] [COMMAND_TIMEOUT=180000]"
	@echo
	@echo "  start    Install dependencies if needed, then run HTTP + WebSocket in the foreground (default)"
	@echo "  stop     Stop a server started by this Makefile or listening on PORT"
	@echo "  restart  Stop and start again"
	@echo "  status   Show the pidfile and /health response"
	@echo "  install  Install the ws dependency"
	@echo "  test     Run the chromium-mcp test suite"
	@echo "  stdio    Run the MCP relay over stdio (extension still uses PORT)"
	@echo "  clean    Remove the pidfile"
	@echo
	@echo "Default endpoint:  http://$(HOST):$(PORT)/mcp"
	@echo "Extension socket:  ws://$(HOST):$(PORT)/extension"

deps:
	@if [ ! -d "$(CURDIR)/node_modules/ws" ]; then \
		echo "Installing chromium-mcp dependencies..."; \
		cd "$(CURDIR)" && $(NPM) ci --no-audit --no-fund; \
	fi

start: deps
	@if [ -f "$(PIDFILE)" ] && kill -0 "$$(cat "$(PIDFILE)")" 2>/dev/null; then \
		echo "chromium-mcp is already running (pid $$(cat "$(PIDFILE)"))"; \
		exit 0; \
	fi
	@if command -v curl >/dev/null 2>&1 && curl -sf "http://$(HEALTH_HOST):$(PORT)/health" >/dev/null 2>&1; then \
		echo "chromium-mcp already responds on http://$(HEALTH_HOST):$(PORT)/mcp; run 'make stop' first"; \
		exit 0; \
	fi
	@echo "Starting chromium-mcp on http://$(HOST):$(PORT)/mcp (Ctrl-C to stop)"
	@echo "Extension WebSocket: ws://$(HOST):$(PORT)/extension"
	@echo $$$$ > "$(PIDFILE)"; $(RUN_ENV) exec $(NODE) "$(ENTRY)" --http

stop:
	@if [ -f "$(PIDFILE)" ]; then \
		pid=$$(cat "$(PIDFILE)"); \
		if kill -0 "$$pid" 2>/dev/null; then \
			echo "Stopping chromium-mcp (pid $$pid)"; \
			kill "$$pid" 2>/dev/null || true; \
			for i in $$(seq 1 50); do kill -0 "$$pid" 2>/dev/null || break; sleep 0.1; done; \
			kill -9 "$$pid" 2>/dev/null || true; \
		fi; \
		rm -f "$(PIDFILE)"; \
	fi; \
	if command -v lsof >/dev/null 2>&1; then \
		pids=$$(lsof -ti tcp:$(PORT) 2>/dev/null || true); \
		if [ -n "$$pids" ]; then echo "Stopping listener(s) on port $(PORT): $$pids"; kill $$pids 2>/dev/null || true; fi; \
	fi; \
	if command -v fuser >/dev/null 2>&1; then \
		fuser -k $(PORT)/tcp >/dev/null 2>&1 || true; \
	fi; \
	if command -v pgrep >/dev/null 2>&1; then \
		pids=$$(pgrep -f "[c]hromium-mcp/relay.mjs.*--http" 2>/dev/null || true); \
		if [ -n "$$pids" ]; then echo "Stopping chromium-mcp process(es): $$pids"; kill $$pids 2>/dev/null || true; fi; \
	fi; \
	true

restart: stop
	@$(MAKE) --no-print-directory start

status:
	@if [ -f "$(PIDFILE)" ]; then echo "pidfile: $$(cat "$(PIDFILE)")"; else echo "pidfile: (none)"; fi
	@if command -v curl >/dev/null 2>&1; then \
		curl -sS -m 2 "http://$(HEALTH_HOST):$(PORT)/health" || echo "health: not responding"; \
	else \
		echo "health: curl not available"; \
	fi

install:
	cd "$(CURDIR)" && $(NPM) ci --no-audit --no-fund

test: deps
	$(NODE) --test $(CURDIR)/test/*.test.mjs

stdio: deps
	@echo "Starting chromium-mcp in stdio mode."
	@echo "Extension WebSocket: ws://$(HOST):$(PORT)/extension"
	@$(STDIO_ENV) $(NODE) "$(ENTRY)"

clean:
	@rm -f "$(PIDFILE)"
