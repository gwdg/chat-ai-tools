SHELL := /bin/bash
.DEFAULT_GOAL := start

NODE ?= node
NPM ?= npm
HOST ?= 127.0.0.1
PORT ?= 8766
DB ?= $(CURDIR)/crm.db
ACTOR ?= mcp-client
PASSWORD ?=
DEBUG ?= 0
OUTPUT ?=

ENTRY := $(CURDIR)/dist/index.js
PIDFILE := $(CURDIR)/.crm-mcp.pid

FLAGS := --http --host $(HOST) --port $(PORT) --db "$(DB)" --actor "$(ACTOR)"
ifeq ($(DEBUG),1)
FLAGS += --debug
endif
ifneq ($(PASSWORD),)
FLAGS += --password "$(PASSWORD)"
endif

.PHONY: help start stop restart build typecheck test status backup clean

help:
	@echo "Usage: make <target> [PORT=8766] [DB=/path/to/crm.db] [PASSWORD=secret] [DEBUG=1] [OUTPUT=/path/to/reports]"
	@echo
	@echo "  start    Build, then run the CRM HTTP server in the foreground (default)"
	@echo "  stop     Stop a server started by this Makefile or listening on PORT"
	@echo "  restart  Stop, rebuild, and start"
	@echo "  status   Show the pidfile and /health response"
	@echo "  build    Compile TypeScript to dist/"
	@echo "  typecheck  Run tsc without emitting"
	@echo "  test     Run the CRM test suite"
	@echo "  backup   Write a VACUUM INTO snapshot next to the database"
	@echo "  clean    Remove the pidfile (keeps the database)"
	@echo
	@echo "Default database: $(DB)"
	@echo "Default endpoint: http://$(HOST):$(PORT)/mcp"
	@echo "Default report directory: $(if $(OUTPUT),$(OUTPUT),./reports)"

start: build
	@if [ -f "$(PIDFILE)" ] && kill -0 "$$(cat "$(PIDFILE)")" 2>/dev/null; then \
		echo "crm-mcp is already running (pid $$(cat "$(PIDFILE)"))"; \
		exit 0; \
	fi
	@if command -v curl >/dev/null 2>&1 && curl -sf "http://$(HOST):$(PORT)/health" >/dev/null 2>&1; then \
		echo "crm-mcp already responds on http://$(HOST):$(PORT)/mcp; run 'make stop' first"; \
		exit 0; \
	fi
	@if [ -n "$(OUTPUT)" ]; then \
		dir="$(OUTPUT)"; \
		if [ "$${dir:0:1}" = "~" ]; then dir="$$HOME$${dir:1}"; fi; \
		mkdir -p -m 700 "$$dir" && echo "Report directory: $$dir"; \
	fi
	@echo "Starting crm-mcp on http://$(HOST):$(PORT)/mcp"
	@echo "Database: $(DB)"
	@echo "Report directory: $(if $(OUTPUT),$(OUTPUT),./reports)"
	@echo "Press Ctrl-C to stop."
	@echo $$$$ > "$(PIDFILE)"
	@CRM_REPORT_DIR="$(OUTPUT)" exec $(NODE) "$(ENTRY)" $(FLAGS)

stop:
	@if [ -f "$(PIDFILE)" ]; then \
		pid=$$(cat "$(PIDFILE)"); \
		if kill -0 "$$pid" 2>/dev/null; then \
			echo "Stopping crm-mcp (pid $$pid)"; \
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
		pids=$$(pgrep -f "[c]rm-mcp.*--port $(PORT)" 2>/dev/null || true); \
		if [ -n "$$pids" ]; then echo "Stopping crm-mcp process(es): $$pids"; kill $$pids 2>/dev/null || true; fi; \
	fi; \
	true

restart: stop
	@$(MAKE) --no-print-directory start

status:
	@if [ -f "$(PIDFILE)" ]; then echo "pidfile: $$(cat "$(PIDFILE)")"; else echo "pidfile: (none)"; fi
	@if command -v curl >/dev/null 2>&1; then \
		curl -sS -m 2 "http://$(HOST):$(PORT)/health" || echo "health: not responding"; \
	else \
		echo "health: curl not available"; \
	fi

build:
	cd "$(CURDIR)" && $(NPM) run build

typecheck:
	cd "$(CURDIR)" && $(NPM) run typecheck

test:
	cd "$(CURDIR)" && $(NPM) test

backup:
	@if [ ! -f "$(DB)" ]; then echo "Database not found: $(DB)"; exit 1; fi
	@if ! command -v sqlite3 >/dev/null 2>&1; then echo "sqlite3 is required for backup"; exit 1; fi
	@backup="$(DB).backup-$$(date +%Y%m%d-%H%M%S)"; \
	echo "Writing $$backup"; \
	sqlite3 "$(DB)" "VACUUM INTO '$$backup'"; \
	echo "Backup complete: $$backup"

clean:
	@rm -f "$(PIDFILE)"
