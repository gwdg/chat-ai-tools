SHELL := /bin/bash
.DEFAULT_GOAL := restart

NODE ?= node
NPM ?= npm
HOST ?= 127.0.0.1
PORT ?= 8765
HEALTH_HOST ?= 127.0.0.1
DEBUG ?= 1
READ_ONLY ?= 0
PROFILE ?=

ENTRY := $(CURDIR)/dist/index.js
PIDFILE := $(CURDIR)/.thunderbird-mcp.pid

FLAGS := --http --host $(HOST) --port $(PORT)
ifeq ($(DEBUG),1)
FLAGS += --debug
endif
ifeq ($(READ_ONLY),1)
FLAGS += --read-only
endif
ifneq ($(PROFILE),)
FLAGS += --profile "$(PROFILE)"
endif

.PHONY: help restart start stop build typecheck test status clean

help:
	@echo "Usage: make <target> [DEBUG=1] [READ_ONLY=1] [PORT=8765] [HOST=127.0.0.1] [PROFILE=/path/to/profile]"
	@echo "PROFILE is auto-detected by default; set PROFILE=/path/to/profile to choose explicitly"
	@echo
	@echo "  restart  Stop any running server, rebuild, then run in the foreground (default)"
	@echo "  start    Build and run the HTTP server in the foreground"
	@echo "  stop     Stop a server started in another terminal (pidfile, then port lookup)"
	@echo "  status   Show pidfile contents and /health response"
	@echo "  build    Compile TypeScript to dist/"
	@echo "  typecheck  Run tsc without emitting"
	@echo "  test     Run the test suite"
	@echo "  clean    Remove the pidfile"

restart: stop
	@$(MAKE) --no-print-directory start

start: build
	@if [ -f "$(PIDFILE)" ] && kill -0 "$$(cat "$(PIDFILE)")" 2>/dev/null; then \
		echo "thunderbird-mcp is already running (pid $$(cat "$(PIDFILE)"))"; \
		exit 0; \
	fi
	@if command -v curl >/dev/null 2>&1 && curl -sf "http://$(HEALTH_HOST):$(PORT)/health" >/dev/null 2>&1; then \
		echo "thunderbird-mcp already responds on http://$(HEALTH_HOST):$(PORT)/mcp; run 'make stop' first"; \
		exit 0; \
	fi
	@echo "Starting thunderbird-mcp on http://$(HOST):$(PORT)/mcp (Ctrl-C to stop)"
	@echo $$$$ > "$(PIDFILE)"; exec $(NODE) "$(ENTRY)" $(FLAGS)

stop:
	@if [ -f "$(PIDFILE)" ]; then \
		pid=$$(cat "$(PIDFILE)"); \
		if kill -0 "$$pid" 2>/dev/null; then \
			echo "Stopping thunderbird-mcp (pid $$pid)"; \
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
		pids=$$(pgrep -f "[d]ist/index.js.*--port $(PORT)" 2>/dev/null || true); \
		if [ -n "$$pids" ]; then echo "Stopping thunderbird-mcp process(es): $$pids"; kill $$pids 2>/dev/null || true; fi; \
	fi; \
	true

status:
	@if [ -f "$(PIDFILE)" ]; then echo "pidfile: $$(cat "$(PIDFILE)")"; else echo "pidfile: (none)"; fi
	@if command -v curl >/dev/null 2>&1; then \
		curl -sS -m 2 "http://$(HEALTH_HOST):$(PORT)/health" || echo "health: not responding"; \
	else \
		echo "health: curl not available"; \
	fi

build:
	cd "$(CURDIR)" && $(NPM) run build

typecheck:
	cd "$(CURDIR)" && $(NPM) run typecheck

test:
	cd "$(CURDIR)" && $(NPM) test

clean:
	@rm -f "$(PIDFILE)"
