import {
  SNAPSHOT_ATTR,
  isControllableUrl,
  normalizeNavigationUrl,
  originOf,
  tabGrantKey,
} from "./permissions.js";

const DEFAULT_RELAY_URL = "ws://127.0.0.1:8766/extension";
const CONFIRM_TIMEOUT_MS = 90_000;
const VERSION = chrome.runtime.getManifest().version;

const state = {
  connection: "disconnected",
  error: null,
  relayUrl: null,
  relayVersion: null,
};

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let enabled = true;
let authRejected = false;
let commandChain = Promise.resolve();

const pendingConfirmations = new Map();
const confirmationQueue = [];
let activeConfirmation = null;
let confirmationWindowId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setState(patch) {
  Object.assign(state, patch);
  void updateBadge();
  void broadcastStatus();
}

async function updateBadge() {
  const text = state.connection === "connected" ? "ON" : "";
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
  } catch {
    // Badge is best-effort.
  }
}

function statusPayload() {
  return {
    connection: state.connection,
    error: state.error,
    relayUrl: state.relayUrl,
    relayVersion: state.relayVersion,
    version: VERSION,
  };
}

async function broadcastStatus() {
  try {
    await chrome.runtime.sendMessage({ type: "status", status: statusPayload() });
  } catch {
    // No extension page is listening.
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get([
    "relayUrl",
    "extensionToken",
    "enabled",
  ]);
  return {
    relayUrl:
      typeof stored.relayUrl === "string" && stored.relayUrl.trim()
        ? stored.relayUrl.trim()
        : DEFAULT_RELAY_URL,
    token: typeof stored.extensionToken === "string" ? stored.extensionToken : "",
    enabled: stored.enabled !== false,
  };
}

function scheduleReconnect() {
  if (!enabled || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 5_000);
}

async function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const settings = await getSettings();
  enabled = settings.enabled;
  authRejected = false;
  if (!enabled) {
    setState({ connection: "disabled", error: null, relayUrl: settings.relayUrl });
    return;
  }

  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  setState({
    connection: "connecting",
    error: null,
    relayUrl: settings.relayUrl,
  });

  let current;
  try {
    current = new WebSocket(settings.relayUrl);
  } catch (error) {
    setState({
      connection: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    scheduleReconnect();
    return;
  }

  socket = current;

  current.addEventListener("open", () => {
    reconnectDelay = 1000;
    current.send(
      JSON.stringify({
        type: "hello",
        token: settings.token,
        version: VERSION,
        name: "chromium-mcp-extension",
      }),
    );
  });

  current.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "hello-ok") {
      authRejected = false;
      setState({
        connection: "connected",
        error: null,
        relayUrl: settings.relayUrl,
        relayVersion: message.version ?? null,
      });
      return;
    }
    if (message.type === "hello-error") {
      authRejected = true;
      setState({
        connection: "error",
        error: message.message || "The relay rejected this extension.",
      });
      try {
        current.close(4401, "hello rejected");
      } catch {
        // Ignore.
      }
      return;
    }
    if (message.type === "ping") {
      send({
        type: "pong",
        time: typeof message.time === "number" ? message.time : Date.now(),
      });
      return;
    }
    if (message.type === "pong") {
      return;
    }
    if (message.type === "command") {
      commandChain = commandChain
        .then(() => handleCommand(message))
        .catch(() => undefined);
    }
  });

  current.addEventListener("close", (event) => {
    if (socket === current) socket = null;
    console.warn(
      `[chromium-mcp] relay disconnected (code ${event.code}${
        event.reason ? `, ${event.reason}` : ""
      })`,
    );
    cancelPendingConfirmations(
      "The MCP relay disconnected before the request was answered.",
    );
    setState({
      connection: enabled
        ? state.error
          ? "error"
          : "disconnected"
        : "disabled",
    });
    if (!authRejected) scheduleReconnect();
  });

  current.addEventListener("error", () => {
    // The close event carries the useful state transition.
  });
}

async function disconnect() {
  enabled = false;
  await chrome.storage.local.set({ enabled: false });
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = socket;
  socket = null;
  if (current) {
    try {
      current.close(1000, "disconnected by user");
    } catch {
      // Ignore.
    }
  }
  setState({ connection: "disabled", error: null });
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The close handler will update state.
  }
}

async function sessionGrants() {
  const stored = await chrome.storage.session.get("grants");
  return stored.grants && typeof stored.grants === "object"
    ? stored.grants
    : {};
}

async function hasSessionGrant(key) {
  if (!key) return false;
  const grants = await sessionGrants();
  return Boolean(grants[key]);
}

async function saveSessionGrant(key) {
  if (!key) return;
  const grants = await sessionGrants();
  grants[key] = Date.now();
  await chrome.storage.session.set({ grants });
}

async function revokeAllGrants() {
  await chrome.storage.session.set({ grants: {} });
}

function detailsFor(id) {
  const entry = pendingConfirmations.get(id);
  if (!entry) return null;
  return {
    purpose: entry.purpose,
    title: entry.title,
    url: entry.url,
    origin: entry.origin,
  };
}

async function showNextConfirmation() {
  if (activeConfirmation || !confirmationQueue.length) return;

  const id = confirmationQueue.shift();
  const entry = pendingConfirmations.get(id);
  if (!entry) {
    void showNextConfirmation();
    return;
  }

  activeConfirmation = id;
  try {
    const window = await chrome.windows.create({
      url: chrome.runtime.getURL(`confirm.html?id=${encodeURIComponent(id)}`),
      type: "popup",
      width: 480,
      height: 430,
      focused: true,
    });
    confirmationWindowId = window.id;
    entry.timer = setTimeout(() => {
      void resolveConfirmation(
        id,
        "deny",
        "The confirmation request timed out.",
      );
    }, CONFIRM_TIMEOUT_MS);
  } catch (error) {
    await resolveConfirmation(
      id,
      "deny",
      `Could not open the confirmation window: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function resolveConfirmation(id, choice, reason) {
  const entry = pendingConfirmations.get(id);
  if (!entry) return;

  pendingConfirmations.delete(id);
  if (entry.timer) clearTimeout(entry.timer);

  if (activeConfirmation === id) {
    activeConfirmation = null;
    const windowId = confirmationWindowId;
    confirmationWindowId = null;
    if (windowId) {
      try {
        await chrome.windows.remove(windowId);
      } catch {
        // Already closed.
      }
    }
  }

  if (choice === "deny") {
    entry.reject(
      new Error(reason || "The user denied access to this tab."),
    );
  } else {
    if (choice === "session") await saveSessionGrant(entry.key);
    entry.resolve({ choice, origin: entry.origin, key: entry.key });
  }

  void showNextConfirmation();
}

function requestAccess(tabId, purpose, urlOverride) {
  return (async () => {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error("The tab no longer exists.");
    }

    const url = urlOverride || tab.url || tab.pendingUrl || "";
    const origin = originOf(url);
    if (!origin) {
      throw new Error(
        "This tab cannot be controlled because its URL is not http(s).",
      );
    }

    const key = tabGrantKey(tabId, url);
    if (await hasSessionGrant(key)) {
      return { tab, origin, key, choice: "session" };
    }

    return await new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pendingConfirmations.set(id, {
        id,
        tabId,
        purpose,
        title: tab.title || "",
        url,
        origin,
        key,
        resolve,
        reject,
        timer: null,
      });
      confirmationQueue.push(id);
      void showNextConfirmation();
    });
  })();
}

function cancelPendingConfirmations(reason) {
  for (const id of [...pendingConfirmations.keys()]) {
    void resolveConfirmation(id, "deny", reason);
  }
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== confirmationWindowId) return;
  const id = activeConfirmation;
  confirmationWindowId = null;
  if (id) {
    void resolveConfirmation(
      id,
      "deny",
      "The confirmation window was closed.",
    );
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const grants = await sessionGrants();
  const prefix = `${tabId}|`;
  let changed = false;
  for (const key of Object.keys(grants)) {
    if (key.startsWith(prefix)) {
      delete grants[key];
      changed = true;
    }
  }
  if (changed) await chrome.storage.session.set({ grants });

  for (const [id, entry] of pendingConfirmations) {
    if (entry.tabId === tabId) {
      void resolveConfirmation(id, "deny", "The tab was closed.");
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  if (message?.type === "status") {
    sendResponse({ ok: true, status: statusPayload() });
    return false;
  }
  if (message?.type === "connect") {
    enabled = true;
    void chrome.storage.local.set({ enabled: true }).then(() => connect());
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "disconnect") {
    void disconnect().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "reconnect") {
    enabled = true;
    void (async () => {
      await chrome.storage.local.set({ enabled: true });
      const current = socket;
      socket = null;
      if (current) {
        try {
          current.close(1000, "reconnecting");
        } catch {
          // Ignore.
        }
      }
      await connect();
    })();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "revoke-grants") {
    void revokeAllGrants().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "confirmation-details") {
    const details = detailsFor(message.id);
    sendResponse(
      details
        ? { ok: true, details }
        : { ok: false, error: "This confirmation is no longer pending." },
    );
    return false;
  }
  if (message?.type === "confirmation-choice") {
    if (!["once", "session", "deny"].includes(message.choice)) {
      sendResponse({ ok: false, error: "Invalid choice." });
      return false;
    }
    void resolveConfirmation(message.id, message.choice).then(() =>
      sendResponse({ ok: true }),
    );
    return true;
  }
  return false;
});

function locateElement({ id, selector, text }) {
  if (id) {
    return document.querySelector(
      `[${SNAPSHOT_ATTR}="${CSS.escape(String(id))}"]`,
    );
  }
  if (selector) return document.querySelector(selector);
  if (text) {
    const wanted = String(text).trim().toLowerCase();
    const candidates = [
      ...document.querySelectorAll(
        "a,button,input,textarea,select,summary,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[contenteditable='true'],[contenteditable='']",
      ),
    ];
    let partial = null;
    for (const element of candidates) {
      const label = (
        element.getAttribute("aria-label") ||
        element.getAttribute("placeholder") ||
        element.getAttribute("title") ||
        element.innerText ||
        element.value ||
        ""
      )
        .trim()
        .toLowerCase();
      if (!label) continue;
      if (label === wanted) return element;
      if (!partial && label.includes(wanted)) partial = element;
    }
    return partial;
  }
  return null;
}

function labelOf(element) {
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("placeholder") ||
    element.getAttribute("title") ||
    element.innerText ||
    element.value ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

async function readTab(tabId, maxChars, includeLinks) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [maxChars, includeLinks === true],
    func: (limit, withLinks) => {
      const body = document.body;
      const raw = (body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
      const links = withLinks
        ? [...document.querySelectorAll("a[href]")]
            .slice(0, 200)
            .map((anchor) => ({
              text: (anchor.innerText || "").trim().slice(0, 200),
              href: anchor.href,
            }))
        : undefined;
      return {
        ok: true,
        title: document.title,
        url: location.href,
        text: raw.slice(0, limit),
        totalChars: raw.length,
        truncated: raw.length > limit,
        ...(links ? { links } : {}),
      };
    },
  });
  return result.result;
}

async function waitForTab(tabId, timeoutMs) {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete" || Date.now() - started >= timeoutMs) {
          resolve(tab);
          return;
        }
        setTimeout(check, 200);
      } catch (error) {
        reject(error);
      }
    };
    void check();
  });
}

async function ensureAccess(params, purpose, urlOverride) {
  const tabId = Number.isInteger(params.tabId)
    ? params.tabId
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))
        .at(0)?.id;
  if (!Number.isInteger(tabId)) throw new Error("No active tab found.");
  const access = await requestAccess(tabId, purpose, urlOverride);
  return { tabId, ...access };
}

const handlers = {
  async "tabs.list"() {
    const tabs = await chrome.tabs.query({});
    const grants = await sessionGrants();
    return tabs.map((tab) => {
      const url = tab.url || tab.pendingUrl || "";
      const key = tabGrantKey(tab.id, url);
      const granted = Boolean(key && grants[key]);
      return {
        id: tab.id,
        windowId: tab.windowId,
        active: tab.active,
        granted,
        restricted: !isControllableUrl(url),
        ...(granted ? { title: tab.title || "", url } : {}),
      };
    });
  },

  async "tabs.activate"(params) {
    const { tabId, tab } = await ensureAccess(
      params,
      "switch to this tab",
    );
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { tabId, title: tab.title || "", url: tab.url || "" };
  },

  async "tab.close"(params) {
    const { tabId } = await ensureAccess(params, "close this tab");
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },

  async "page.open"(params) {
    const url = normalizeNavigationUrl(params.url);
    const timeoutMs = Math.min(
      Math.max(Number(params.timeoutMs) || 30_000, 1_000),
      120_000,
    );

    let tab;
    if (Number.isInteger(params.tabId)) {
      const tabId = params.tabId;
      await ensureAccess(params, "open a page in this tab", url);
      await chrome.tabs.update(tabId, { url });
      tab = await waitForTab(tabId, timeoutMs);
    } else if (params.newTab === false) {
      const { tabId } = await ensureAccess(
        {},
        "open a page in this tab",
        url,
      );
      await chrome.tabs.update(tabId, { url });
      tab = await waitForTab(tabId, timeoutMs);
    } else {
      tab = await chrome.tabs.create({ url, active: true });
      try {
        await requestAccess(tab.id, "access the newly opened tab", url);
      } catch (error) {
        await chrome.tabs.remove(tab.id).catch(() => undefined);
        throw error;
      }
      tab = await waitForTab(tab.id, timeoutMs);
    }

    const summary = await readTab(
      tab.id,
      Math.min(Math.max(Number(params.maxChars) || 20_000, 1), 200_000),
      false,
    );
    return {
      tabId: tab.id,
      url: summary?.url || tab.url || url,
      title: summary?.title || tab.title || "",
      text: summary?.text || "",
      truncated: Boolean(summary?.truncated),
    };
  },

  async "page.read"(params) {
    const { tabId } = await ensureAccess(params, "read this tab");
    const maxChars = Math.min(
      Math.max(Number(params.maxChars) || 20_000, 1),
      200_000,
    );
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [
        params.selector || null,
        params.format === "html" ? "html" : "text",
        maxChars,
        params.includeLinks === true,
      ],
      func: (selector, format, limit, withLinks) => {
        const root = selector
          ? document.querySelector(selector)
          : document.body;
        if (!root) {
          return { ok: false, error: `No element matches selector: ${selector}` };
        }
        const raw =
          format === "html"
            ? root.outerHTML
            : root.innerText || root.textContent || "";
        const links = withLinks
          ? [...document.querySelectorAll("a[href]")]
              .slice(0, 200)
              .map((anchor) => ({
                text: (anchor.innerText || "").trim().slice(0, 200),
                href: anchor.href,
              }))
          : undefined;
        return {
          ok: true,
          title: document.title,
          url: location.href,
          text: raw.slice(0, limit),
          totalChars: raw.length,
          truncated: raw.length > limit,
          ...(links ? { links } : {}),
        };
      },
    });
    if (!result.result?.ok) throw new Error(result.result?.error || "Read failed.");
    return { tabId, ...result.result };
  },

  async "page.snapshot"(params) {
    const { tabId } = await ensureAccess(params, "inspect this tab");
    const limit = Math.min(
      Math.max(Number(params.maxElements) || 200, 1),
      1000,
    );
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [SNAPSHOT_ATTR, limit],
      func: (attr, maxElements) => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            style.opacity !== "0"
          );
        };
        const clean = (value) =>
          String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);

        for (const old of document.querySelectorAll(`[${attr}]`)) {
          old.removeAttribute(attr);
        }

        const elements = [];
        let index = 0;
        for (const element of document.querySelectorAll(
          "a[href],button,input,textarea,select,summary,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='tab'],[role='menuitem'],[role='switch'],[contenteditable=''],[contenteditable='true']",
        )) {
          if (elements.length >= maxElements) break;
          if (!visible(element)) continue;
          const tag = element.tagName.toLowerCase();
          const id = String(++index);
          element.setAttribute(attr, id);
          elements.push({
            id,
            tag,
            type: clean(element.getAttribute("type")) || undefined,
            role: clean(element.getAttribute("role")) || undefined,
            name:
              clean(
                element.getAttribute("aria-label") ||
                  element.getAttribute("placeholder") ||
                  element.getAttribute("alt") ||
                  element.getAttribute("title") ||
                  element.innerText ||
                  element.value,
              ) || undefined,
            value:
              tag === "input" || tag === "textarea" || tag === "select"
                ? clean(element.value) || undefined
                : undefined,
            href: tag === "a" ? element.href : undefined,
            checked:
              element instanceof HTMLInputElement &&
              (element.type === "checkbox" || element.type === "radio")
                ? element.checked
                : undefined,
            disabled: element.disabled === true || undefined,
          });
        }

        return {
          ok: true,
          title: document.title,
          url: location.href,
          textPreview: String(document.body?.innerText || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 400),
          elements,
        };
      },
    });
    if (!result.result?.ok) throw new Error(result.result?.error || "Snapshot failed.");
    return { tabId, ...result.result };
  },

  async "page.click"(params) {
    const { tabId } = await ensureAccess(params, "click on this tab");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [
        {
          id: params.id || null,
          selector: params.selector || null,
          text: params.text || null,
        },
        SNAPSHOT_ATTR,
      ],
      func: (target, attr) => {
        const locate = ({ id, selector, text }) => {
          if (id) {
            return document.querySelector(
              `[${attr}="${CSS.escape(String(id))}"]`,
            );
          }
          if (selector) return document.querySelector(selector);
          if (text) {
            const wanted = String(text).trim().toLowerCase();
            const candidates = [
              ...document.querySelectorAll(
                "a,button,input,textarea,select,summary,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[contenteditable='true'],[contenteditable='']",
              ),
            ];
            let partial = null;
            for (const element of candidates) {
              const label = (
                element.getAttribute("aria-label") ||
                element.getAttribute("placeholder") ||
                element.getAttribute("title") ||
                element.innerText ||
                element.value ||
                ""
              )
                .trim()
                .toLowerCase();
              if (!label) continue;
              if (label === wanted) return element;
              if (!partial && label.includes(wanted)) partial = element;
            }
            return partial;
          }
          return null;
        };

        const element = locate(target);
        if (!element) return { ok: false, error: "No matching element." };
        element.scrollIntoView({ block: "center", inline: "center" });
        element.click();
        return {
          ok: true,
          tag: element.tagName.toLowerCase(),
          label: (
            element.getAttribute("aria-label") ||
            element.innerText ||
            element.value ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160),
        };
      },
    });
    if (!result.result?.ok) {
      throw new Error(result.result?.error || "Click failed.");
    }
    await sleep(250);
    const tab = await chrome.tabs.get(tabId);
    return {
      tabId,
      label: result.result.label || "",
      url: tab.url || "",
      title: tab.title || "",
    };
  },

  async "page.type"(params) {
    if (typeof params.value !== "string") {
      throw new Error("The value argument is required.");
    }
    const { tabId } = await ensureAccess(params, "type into this tab");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [
        {
          id: params.id || null,
          selector: params.selector || null,
          text: params.text || null,
        },
        params.value,
        params.clear !== false,
        params.submit === true,
        SNAPSHOT_ATTR,
      ],
      func: (target, value, clear, submit, attr) => {
        const locate = ({ id, selector, text }) => {
          if (id) {
            return document.querySelector(
              `[${attr}="${CSS.escape(String(id))}"]`,
            );
          }
          if (selector) return document.querySelector(selector);
          if (text) {
            const wanted = String(text).trim().toLowerCase();
            const candidates = [
              ...document.querySelectorAll(
                "input,textarea,select,[contenteditable='true'],[contenteditable='']",
              ),
            ];
            let partial = null;
            for (const element of candidates) {
              const label = (
                element.getAttribute("aria-label") ||
                element.getAttribute("placeholder") ||
                element.getAttribute("title") ||
                element.innerText ||
                element.value ||
                ""
              )
                .trim()
                .toLowerCase();
              if (!label) continue;
              if (label === wanted) return element;
              if (!partial && label.includes(wanted)) partial = element;
            }
            return partial;
          }
          return null;
        };

        const element = locate(target);
        if (!element) return { ok: false, error: "No matching field." };
        element.scrollIntoView({ block: "center", inline: "center" });
        element.focus();

        if (element.tagName === "SELECT") {
          const option = [...element.options].find(
            (candidate) =>
              candidate.value === value ||
              candidate.textContent.trim() === value,
          );
          if (!option) {
            return { ok: false, error: `No option matches "${value}".` };
          }
          element.value = option.value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (element.isContentEditable) {
          if (clear) element.textContent = "";
          element.textContent = `${element.textContent || ""}${value}`;
          element.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              data: value,
              inputType: "insertText",
            }),
          );
        } else {
          const prototype =
            element instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(
            prototype,
            "value",
          )?.set;
          const next = clear ? value : `${element.value || ""}${value}`;
          if (setter) setter.call(element, next);
          else element.value = next;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }

        if (submit) {
          const key = {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
          };
          element.dispatchEvent(new KeyboardEvent("keydown", key));
          element.dispatchEvent(new KeyboardEvent("keypress", key));
          element.dispatchEvent(new KeyboardEvent("keyup", key));
          const form =
            element.closest && element.closest("form")
              ? element.closest("form")
              : null;
          if (form && typeof form.requestSubmit === "function") {
            form.requestSubmit();
          }
        }

        return { ok: true, tag: element.tagName.toLowerCase() };
      },
    });
    if (!result.result?.ok) {
      throw new Error(result.result?.error || "Typing failed.");
    }
    await sleep(200);
    const tab = await chrome.tabs.get(tabId);
    return { tabId, url: tab.url || "", title: tab.title || "" };
  },

  async "page.press"(params) {
    if (typeof params.key !== "string" || !params.key) {
      throw new Error("The key argument is required.");
    }
    const { tabId } = await ensureAccess(params, "send a key to this tab");
    const times = Math.min(Math.max(Number(params.times) || 1, 1), 20);
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [params.key, times],
      func: (key, count) => {
        const target = document.activeElement || document.body;
        for (let index = 0; index < count; index += 1) {
          const init = {
            key,
            code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
            bubbles: true,
            cancelable: true,
          };
          target.dispatchEvent(new KeyboardEvent("keydown", init));
          target.dispatchEvent(new KeyboardEvent("keypress", init));
          target.dispatchEvent(new KeyboardEvent("keyup", init));
        }
        if (key === "Enter") {
          const form =
            target.closest && target.closest("form")
              ? target.closest("form")
              : null;
          if (form && typeof form.requestSubmit === "function") {
            form.requestSubmit();
          }
        }
        return { ok: true };
      },
    });
    await sleep(150);
    const tab = await chrome.tabs.get(tabId);
    return { tabId, url: tab.url || "", title: tab.title || "" };
  },

  async "page.scroll"(params) {
    const { tabId } = await ensureAccess(params, "scroll this tab");
    const direction = ["up", "down", "top", "bottom"].includes(
      params.direction,
    )
      ? params.direction
      : "down";
    const amount = Math.min(Math.max(Number(params.amount) || 600, 1), 20_000);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [direction, amount, params.selector || null],
      func: (dir, pixels, selector) => {
        if (selector) {
          const element = document.querySelector(selector);
          if (!element) {
            return { ok: false, error: `No element matches selector: ${selector}` };
          }
          element.scrollIntoView({ block: "start", inline: "nearest" });
        } else if (dir === "top") {
          window.scrollTo({ top: 0 });
        } else if (dir === "bottom") {
          window.scrollTo({ top: document.body.scrollHeight });
        } else {
          window.scrollBy({ top: dir === "up" ? -pixels : pixels });
        }
        return {
          ok: true,
          scrollY: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
        };
      },
    });
    if (!result.result?.ok) {
      throw new Error(result.result?.error || "Scroll failed.");
    }
    return { tabId, ...result.result };
  },

  async "page.waitFor"(params) {
    const { tabId } = await ensureAccess(params, "wait for content in this tab");
    const selector = params.selector || null;
    const text = params.text || null;
    if (!selector && !text) {
      throw new Error("Provide selector or text to wait for.");
    }
    const state = ["attached", "visible", "hidden"].includes(params.state)
      ? params.state
      : "visible";
    const timeoutMs = Math.min(
      Math.max(Number(params.timeoutMs) || 30_000, 1_000),
      120_000,
    );
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [selector, text, state],
        func: (sel, needle, wantedState) => {
          if (sel) {
            const element = document.querySelector(sel);
            if (wantedState === "attached") return Boolean(element);
            if (wantedState === "hidden") return !element;
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          }
          return String(document.body?.innerText || "")
            .toLowerCase()
            .includes(String(needle).toLowerCase());
        },
      });
      if (result.result === true) {
        const tab = await chrome.tabs.get(tabId);
        return { tabId, matched: true, url: tab.url || "", title: tab.title || "" };
      }
      await sleep(250);
    }
    throw new Error("Timed out waiting for the page condition.");
  },

  async "page.evaluate"(params) {
    if (typeof params.expression !== "string" || !params.expression.trim()) {
      throw new Error("The expression argument is required.");
    }
    const { tabId } = await ensureAccess(params, "run JavaScript in this tab");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [params.expression],
      func: async (code) => {
        try {
          const value = await (0, eval)(code);
          return { ok: true, value };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
    if (!result.result?.ok) {
      throw new Error(result.result?.error || "Evaluation failed.");
    }
    return { tabId, value: result.result.value };
  },

  async "page.screenshot"(params) {
    const { tabId, tab } = await ensureAccess(
      params,
      "take a screenshot of this tab",
    );
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(
      () => undefined,
    );
    await sleep(150);
    const format = params.format === "jpeg" ? "jpeg" : "png";
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format,
    });
    const prefix = `data:image/${format};base64,`;
    if (!dataUrl.startsWith(prefix)) {
      throw new Error("Chrome returned an unexpected screenshot format.");
    }
    return {
      tabId,
      url: tab.url || "",
      title: tab.title || "",
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      data: dataUrl.slice(prefix.length),
    };
  },

  async "page.history"(params) {
    const { tabId } = await ensureAccess(params, "navigate this tab's history");
    const action = ["back", "forward", "reload"].includes(params.action)
      ? params.action
      : "back";
    if (action === "back") await chrome.tabs.goBack(tabId);
    else if (action === "forward") await chrome.tabs.goForward(tabId);
    else await chrome.tabs.reload(tabId);
    await sleep(300);
    const tab = await chrome.tabs.get(tabId);
    return { tabId, url: tab.url || "", title: tab.title || "" };
  },
};

async function handleCommand(message) {
  const { id, method, params = {} } = message;
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown browser method: ${method}`);
    const result = await handler(params);
    send({ type: "result", id, ok: true, result });
  } catch (error) {
    send({
      type: "error",
      id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const RECONNECT_ALARM = "chromium-mcp-reconnect";

function ensureReconnectAlarm() {
  void chrome.alarms
    .get(RECONNECT_ALARM)
    .then((alarm) => {
      if (!alarm) {
        return chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
      }
      return undefined;
    })
    .catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(() => {
  ensureReconnectAlarm();
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  ensureReconnectAlarm();
  void connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  ensureReconnectAlarm();
  if (!enabled) return;
  if (
    !socket ||
    socket.readyState === WebSocket.CLOSED ||
    socket.readyState === WebSocket.CLOSING
  ) {
    void connect();
  }
});

ensureReconnectAlarm();
void connect();
