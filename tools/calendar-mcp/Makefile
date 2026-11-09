SHELL := /bin/bash
.DEFAULT_GOAL := start

NODE ?= node
NPM ?= npm
HOST ?= 127.0.0.1
PORT ?= 8767
CONFIG ?= $(CURDIR)/../../secrets/calendar.json
TOKEN ?=
CORS_ORIGIN ?=

ENTRY := $(CURDIR)/server.mjs
PIDFILE := $(CURDIR)/.calendar-mcp.pid
HEALTH_HOST := $(if $(filter ::1 [::1],$(HOST)),[::1],$(HOST))

RUN_ENV := HOST="$(HOST)" CALENDAR_MCP_HTTP_PORT="$(PORT)" \
	CALENDAR_CONFIG="$(CONFIG)"
ifneq ($(CORS_ORIGIN),)
RUN_ENV += CALENDAR_MCP_CORS_ORIGIN="$(CORS_ORIGIN)"
endif
ifneq ($(TOKEN),)
RUN_ENV += CALENDAR_MCP_TOKEN="$(TOKEN)"
endif

.PHONY: help deps start stop restart status install test stdio clean

help:
	@echo "Usage: make <target> [PORT=8767] [HOST=127.0.0.1] [CONFIG=/path/to/calendar.json]"
	@echo "                      [TOKEN=secret] [CORS_ORIGIN=http://localhost:8080]"
	@echo
	@echo "  start    Install deps if needed, then run HTTP in the foreground (default)"
	@echo "  stop     Stop a server started by this Makefile or listening on PORT"
	@echo "  restart  Stop and start again"
	@echo "  status   Show the pidfile and /health response"
	@echo "  install  Install dependencies"
	@echo "  test     Run the calendar-mcp test suite"
	@echo "  stdio    Run the MCP server over stdio"
	@echo "  clean    Remove the pidfile"
	@echo
	@echo "Default config: $(CONFIG)"
	@echo "Default endpoint: http://$(HOST):$(PORT)/mcp"

deps:
	@if [ ! -d "$(CURDIR)/node_modules/ical.js" ]; then \
		echo "Installing calendar-mcp dependencies..."; \
		cd "$(CURDIR)" && $(NPM) ci --no-audit --no-fund; \
	fi

start: deps
	@if [ -f "$(PIDFILE)" ] && kill -0 "$$(cat "$(PIDFILE)")" 2>/dev/null; then \
		echo "calendar-mcp is already running (pid $$(cat "$(PIDFILE)"))"; \
		exit 0; \
	fi
	@if command -v curl >/dev/null 2>&1 && curl -sf "http://$(HEALTH_HOST):$(PORT)/health" >/dev/null 2>&1; then \
		echo "calendar-mcp already responds on http://$(HEALTH_HOST):$(PORT)/mcp; run 'make stop' first"; \
		exit 0; \
	fi
	@echo "Starting calendar-mcp on http://$(HOST):$(PORT)/mcp"
	@echo "Config: $(CONFIG)"
	@echo "Press Ctrl-C to stop."
	@echo $$$$ > "$(PIDFILE)"; $(RUN_ENV) exec $(NODE) "$(ENTRY)" --http

stop:
	@if [ -f "$(PIDFILE)" ]; then \
		pid=$$(cat "$(PIDFILE)"); \
		if kill -0 "$$pid" 2>/dev/null; then \
			echo "Stopping calendar-mcp (pid $$pid)"; \
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
		pids=$$(pgrep -f "[c]alendar-mcp/server.mjs.*--http" 2>/dev/null || true); \
		if [ -n "$$pids" ]; then echo "Stopping calendar-mcp process(es): $$pids"; kill $$pids 2>/dev/null || true; fi; \
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
	@CALENDAR_CONFIG="$(CONFIG)" $(NODE) "$(ENTRY)"

clean:
	@rm -f "$(PIDFILE)"
