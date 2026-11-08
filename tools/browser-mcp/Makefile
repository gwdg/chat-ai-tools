SHELL := /bin/bash
.DEFAULT_GOAL := start

NODE ?= node
NPM ?= npm
HOST ?= 127.0.0.1
PORT ?= 3922
CHROME ?=
ALLOWED_HOSTS ?=
USER_DATA_DIR ?=
CORS_ORIGIN ?=
TOKEN ?=
SESSION_IDLE ?= 1800000
MAX_SESSIONS ?= 20
HUMANIZE ?= 1
NO_SANDBOX ?= 0

ENTRY := $(CURDIR)/server.mjs
PIDFILE := $(CURDIR)/.browser-mcp.pid
HEALTH_HOST := $(if $(filter ::1 [::1],$(HOST)),[::1],$(HOST))

RUN_ENV := HOST="$(HOST)" MCP_BROWSER_HTTP_PORT="$(PORT)" \
	MCP_BROWSER_SESSION_IDLE_MS="$(SESSION_IDLE)" \
	MCP_BROWSER_MAX_SESSIONS="$(MAX_SESSIONS)" \
	BROWSER_MCP_HUMANIZE="$(HUMANIZE)"
ifneq ($(CORS_ORIGIN),)
RUN_ENV += MCP_BROWSER_CORS_ORIGIN="$(CORS_ORIGIN)"
endif
ifneq ($(TOKEN),)
RUN_ENV += MCP_BROWSER_TOKEN="$(TOKEN)"
endif
ifneq ($(CHROME),)
RUN_ENV += BROWSER_MCP_CHROME_PATH="$(CHROME)"
endif
ifneq ($(ALLOWED_HOSTS),)
RUN_ENV += BROWSER_MCP_ALLOWED_HOSTS="$(ALLOWED_HOSTS)"
endif
ifneq ($(USER_DATA_DIR),)
RUN_ENV += BROWSER_MCP_USER_DATA_DIR="$(USER_DATA_DIR)"
endif
ifeq ($(NO_SANDBOX),1)
RUN_ENV += BROWSER_MCP_NO_SANDBOX=1
endif

.PHONY: help deps start stop restart status install test stdio clean

help:
	@echo "Usage: make <target> [PORT=3922] [HOST=127.0.0.1] [CHROME=/path/to/chrome]"
	@echo "                      [ALLOWED_HOSTS=example.com] [USER_DATA_DIR=/path] [NO_SANDBOX=1]"
	@echo "                      [SESSION_IDLE=1800000] [MAX_SESSIONS=20] [HUMANIZE=1] [TOKEN=secret]"
	@echo
	@echo "  start    Install dependencies if needed, then run the HTTP server in the foreground (default)"
	@echo "  stop     Stop a server started by this Makefile or listening on PORT"
	@echo "  restart  Stop and start again"
	@echo "  status   Show the pidfile and /health response"
	@echo "  install  Install puppeteer-core"
	@echo "  test     Run the browser MCP test suite"
	@echo "  stdio    Run the server over stdio in the foreground"
	@echo "  clean    Remove the pidfile"
	@echo
	@echo "Default endpoint: http://$(HOST):$(PORT)/mcp"

deps:
	@if [ ! -d "$(CURDIR)/node_modules/puppeteer-core" ]; then \
		echo "Installing puppeteer-core..."; \
		cd "$(CURDIR)" && $(NPM) install --no-audit --no-fund; \
	fi

start: deps
	@if [ -f "$(PIDFILE)" ] && kill -0 "$$(cat "$(PIDFILE)")" 2>/dev/null; then \
		echo "browser-mcp is already running (pid $$(cat "$(PIDFILE)"))"; \
		exit 0; \
	fi
	@if command -v curl >/dev/null 2>&1 && curl -sf "http://$(HEALTH_HOST):$(PORT)/health" >/dev/null 2>&1; then \
		echo "browser-mcp already responds on http://$(HEALTH_HOST):$(PORT)/mcp; run 'make stop' first"; \
		exit 0; \
	fi
	@echo "Starting browser-mcp on http://$(HOST):$(PORT)/mcp (Ctrl-C to stop)"
	@echo $$$$ > "$(PIDFILE)"; $(RUN_ENV) exec $(NODE) "$(ENTRY)" --http

stop:
	@if [ -f "$(PIDFILE)" ]; then \
		pid=$$(cat "$(PIDFILE)"); \
		if kill -0 "$$pid" 2>/dev/null; then \
			echo "Stopping browser-mcp (pid $$pid)"; \
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
		pids=$$(pgrep -f "[b]rowser-mcp/server.mjs.*--http" 2>/dev/null || true); \
		if [ -n "$$pids" ]; then echo "Stopping browser-mcp process(es): $$pids"; kill $$pids 2>/dev/null || true; fi; \
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
	cd "$(CURDIR)" && $(NPM) install --no-audit --no-fund

test: deps
	$(NODE) --test "$(CURDIR)/../../tests/browser-mcp.test.mjs"

stdio: deps
	$(RUN_ENV) $(NODE) "$(ENTRY)"

clean:
	@rm -f "$(PIDFILE)"
