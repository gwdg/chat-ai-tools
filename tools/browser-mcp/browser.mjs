// Headless browser session used by the browser MCP server.
// No network listener lives here; server.mjs owns the MCP transport.

import { existsSync } from "node:fs";
import path from "node:path";

import {
  chromeUserAgent,
  humanClick,
  humanScroll,
  humanType,
  mouseStateFor,
  settle,
} from "./humanize.mjs";

export const SNAPSHOT_ATTR = "data-mcp-browser-id";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_TEXT_CHARS = 200_000;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='switch']",
  "[role='option']",
  "[contenteditable='']",
  "[contenteditable='true']",
].join(",");

const CHROME_CANDIDATES = {
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  win32: [
    path.join(
      process.env.PROGRAMFILES || "C:\\Program Files",
      "Google\\Chrome\\Application\\chrome.exe",
    ),
    path.join(
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      "Google\\Chrome\\Application\\chrome.exe",
    ),
    path.join(
      process.env.LOCALAPPDATA || "",
      "Google\\Chrome\\Application\\chrome.exe",
    ),
    path.join(
      process.env.PROGRAMFILES || "C:\\Program Files",
      "Microsoft\\Edge\\Application\\msedge.exe",
    ),
  ],
};

export function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The "${name}" argument is required.`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseAllowedHosts(value) {
  return String(value || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeNavigationUrl(input, { allowedHosts = [] } = {}) {
  const raw = requireString(input, "url").trim();

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `Invalid URL "${raw}". Use an absolute http:// or https:// URL.`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Blocked URL scheme "${url.protocol}". Only http and https are allowed.`,
    );
  }

  if (allowedHosts.length) {
    const host = url.hostname.toLowerCase();
    const allowed = allowedHosts.some(
      (entry) => host === entry || host.endsWith(`.${entry}`),
    );
    if (!allowed) {
      throw new Error(
        `Host "${host}" is not in BROWSER_MCP_ALLOWED_HOSTS (${allowedHosts.join(", ")}).`,
      );
    }
  }

  return url.toString();
}

export function findChromeExecutable(explicitPath) {
  const requested =
    explicitPath || process.env.BROWSER_MCP_CHROME_PATH || process.env.CHROME_PATH;
  if (requested) {
    if (!existsSync(requested)) {
      throw new Error(`Chrome executable not found at ${requested}.`);
    }
    return requested;
  }

  const candidates = CHROME_CANDIDATES[process.platform] || [];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  throw new Error(
    "No Chrome or Chromium executable found. Install Chrome, or set BROWSER_MCP_CHROME_PATH to the executable.",
  );
}

export async function isBrowserAvailable() {
  try {
    await import("puppeteer-core");
    findChromeExecutable();
    return true;
  } catch {
    return false;
  }
}

export async function launchBrowser({
  executablePath,
  launchOptions = {},
} = {}) {
  const { default: puppeteer } = await import("puppeteer-core");
  const executable = findChromeExecutable(executablePath);
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const noSandbox =
    root ||
    process.env.BROWSER_MCP_NO_SANDBOX === "1" ||
    process.env.BROWSER_MCP_NO_SANDBOX === "true";

  const launch = (extraArgs) =>
    puppeteer.launch({
      ...launchOptions,
      executablePath: executable,
      headless: launchOptions.headless ?? true,
      defaultViewport:
        launchOptions.defaultViewport ?? { width: 1280, height: 900 },
      args: [
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-default-browser-check",
        "--no-first-run",
        ...(noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
        ...(launchOptions.args || []),
        ...extraArgs,
      ],
      userDataDir:
        process.env.BROWSER_MCP_USER_DATA_DIR || launchOptions.userDataDir,
    });

  try {
    return await launch([]);
  } catch (error) {
    const message = String(error?.message || error);
    if (process.platform === "linux" && /sandbox|namespace|zygote/i.test(message)) {
      console.error(
        "browser-mcp: Chrome sandbox is unavailable in this environment; retrying with --no-sandbox.",
      );
      return launch(["--no-sandbox", "--disable-setuid-sandbox"]);
    }
    throw error;
  }
}

export function createBrowserPool({ executablePath, launchOptions } = {}) {
  let browserPromise = null;

  return {
    getBrowser() {
      if (!browserPromise) {
        browserPromise = launchBrowser({ executablePath, launchOptions });
        browserPromise.catch(() => {
          browserPromise = null;
        });
      }
      return browserPromise;
    },
    async close() {
      const pending = browserPromise;
      browserPromise = null;
      if (!pending) return;
      try {
        const instance = await pending;
        await instance.close();
      } catch {
        // Ignore shutdown errors.
      }
    },
  };
}

function textContent(text) {
  return { content: [{ type: "text", text }] };
}

export function createBrowserSession({
  executablePath,
  allowedHosts = parseAllowedHosts(process.env.BROWSER_MCP_ALLOWED_HOSTS),
  launchOptions = {},
  browser: sharedBrowser = null,
  browserProvider,
  isolate = Boolean(sharedBrowser || browserProvider),
  humanize =
    process.env.BROWSER_MCP_HUMANIZE !== "0" &&
    process.env.BROWSER_MCP_HUMANIZE !== "false",
  defaultTimeoutMs = Number(process.env.BROWSER_MCP_TIMEOUT_MS) ||
    DEFAULT_TIMEOUT_MS,
  maxTextChars = Number(process.env.BROWSER_MCP_MAX_CHARS) || MAX_TEXT_CHARS,
} = {}) {
  const tabs = new Map();
  const mouseStates = new WeakMap();
  let activeTabId = null;
  let browser = sharedBrowser;
  let browserPromise = null;
  let context = null;
  let contextPromise = null;
  let humanEnvironmentPromise = null;
  let tabSequence = 0;
  let closed = false;

  const external = Boolean(sharedBrowser || browserProvider);
  const ownsBrowser = !external;
  const isolated = external && isolate;

  function timeoutFor(value) {
    return clampInteger(value, defaultTimeoutMs, 1_000, MAX_TIMEOUT_MS);
  }

  function clampText(value) {
    return clampInteger(value, DEFAULT_MAX_CHARS, 1, maxTextChars);
  }

  function requireOpen() {
    if (closed) throw new Error("The browser session is closed.");
  }

  async function humanEnvironment() {
    if (!humanEnvironmentPromise) {
      humanEnvironmentPromise = (async () => {
        const instance = browser || (await ensureBrowser());
        const version = await instance.version().catch(() => "");
        const locale =
          process.env.BROWSER_MCP_LOCALE ||
          Intl.DateTimeFormat().resolvedOptions().locale ||
          "en-US";
        return {
          userAgent:
            process.env.BROWSER_MCP_USER_AGENT || chromeUserAgent(version),
          locale,
          timezone:
            process.env.BROWSER_MCP_TIMEZONE ||
            Intl.DateTimeFormat().resolvedOptions().timeZone ||
            "",
        };
      })();
    }
    return humanEnvironmentPromise;
  }

  async function applyHumanEnvironment(page) {
    const environment = await humanEnvironment();
    await page.setUserAgent(environment.userAgent);
    const language = environment.locale.includes("-")
      ? `${environment.locale},${environment.locale.split("-")[0]};q=0.9`
      : environment.locale;
    await page.setExtraHTTPHeaders({ "Accept-Language": language });
    await page.emulateLocale(environment.locale).catch(() => {});
    if (environment.timezone) {
      await page.emulateTimezone(environment.timezone).catch(() => {});
    }
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
  }

  async function ensureBrowser() {
    requireOpen();
    if (browser) return browser;
    if (browserPromise) return browserPromise;

    browserPromise = browserProvider
      ? Promise.resolve().then(() => browserProvider())
      : launchBrowser({ executablePath, launchOptions });

    try {
      browser = await browserPromise;
      return browser;
    } catch (error) {
      browserPromise = null;
      throw error;
    }
  }

  async function pageSource() {
    requireOpen();
    if (!isolated) return ensureBrowser();

    if (!contextPromise) {
      contextPromise = (async () => {
        const instance = await ensureBrowser();
        return instance.createBrowserContext();
      })();
    }

    try {
      context = await contextPromise;
      return context;
    } catch (error) {
      contextPromise = null;
      throw error;
    }
  }

  async function createTab() {
    const source = await pageSource();
    const page = await source.newPage();
    if (humanize) await applyHumanEnvironment(page);
    const id = `tab-${++tabSequence}`;
    const entry = { id, page };
    tabs.set(id, entry);
    activeTabId = id;

    page.on("close", () => {
      tabs.delete(id);
      if (activeTabId === id) {
        activeTabId = tabs.size ? [...tabs.keys()].at(-1) : null;
      }
    });

    page.on("dialog", async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        // The dialog may already be gone.
      }
    });

    if (allowedHosts.length) {
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        if (!request.isNavigationRequest()) {
          request.continue().catch(() => {});
          return;
        }

        try {
          normalizeNavigationUrl(request.url(), { allowedHosts });
          request.continue().catch(() => {});
        } catch {
          request.abort("blockedbyclient").catch(() => {});
        }
      });
    }

    await page.setDefaultTimeout(defaultTimeoutMs);
    return entry;
  }

  function resolveTab(target, { allowCreate = false } = {}) {
    const requested = optionalString(target);
    if (requested && requested !== "active") {
      const entry = tabs.get(requested);
      if (!entry) {
        const available = tabs.size ? [...tabs.keys()].join(", ") : "(none)";
        throw new Error(
          `Unknown tab "${requested}". Available tabs: ${available}.`,
        );
      }
      return Promise.resolve(entry);
    }

    if (activeTabId && tabs.has(activeTabId)) {
      return Promise.resolve(tabs.get(activeTabId));
    }

    if (allowCreate) return createTab();

    throw new Error("No page is open. Call browser_open first.");
  }

  async function resolvePage(target, { allowCreate = false } = {}) {
    const entry = await resolveTab(target, { allowCreate });
    activeTabId = entry.id;
    return entry;
  }

  async function readPageSummary(page, maxChars) {
    const summary = await page.evaluate((limit) => {
      const body = document.body;
      const raw = (body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
      return {
        url: location.href,
        title: document.title,
        text: raw.slice(0, limit),
        totalChars: raw.length,
        truncated: raw.length > limit,
      };
    }, maxChars);
    return summary;
  }

  async function findElement(page, args) {
    const snapshotId = optionalString(args.id);
    if (snapshotId) {
      const handle = await page.$(
        `[${SNAPSHOT_ATTR}="${snapshotId.replaceAll('"', '\\"')}"]`,
      );
      if (!handle) {
        throw new Error(
          `No element with snapshot id "${snapshotId}". Run browser_snapshot first.`,
        );
      }
      return handle;
    }

    const selector = optionalString(args.selector);
    if (selector) {
      const handle = await page.$(selector);
      if (!handle) throw new Error(`No element matches selector: ${selector}`);
      return handle;
    }

    const text = optionalString(args.text);
    if (text) {
      const handle = await page.evaluateHandle(
        ({ needle, interactiveSelector }) => {
          const wanted = String(needle).trim().toLowerCase();
          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };
          const labelOf = (el) =>
            (
              el.getAttribute("aria-label") ||
              el.getAttribute("placeholder") ||
              el.getAttribute("title") ||
              el.innerText ||
              el.value ||
              ""
            )
              .trim()
              .toLowerCase();

          let partial = null;
          for (const el of document.querySelectorAll(interactiveSelector)) {
            if (!isVisible(el)) continue;
            const label = labelOf(el);
            if (!label) continue;
            if (label === wanted) return el;
            if (!partial && label.includes(wanted)) partial = el;
          }
          return partial;
        },
        { needle: text, interactiveSelector: INTERACTIVE_SELECTOR },
      );
      const element = handle.asElement();
      if (!element) throw new Error(`No clickable element matches text: ${text}`);
      return element;
    }

    throw new Error(
      "Provide id (from browser_snapshot), selector, or text to locate an element.",
    );
  }

  async function finishNavigationAction(page) {
    if (humanize) await settle();
    else await sleep(150);
    try {
      const [url, title] = await Promise.all([page.url(), page.title()]);
      return { url, title };
    } catch {
      return { url: page.url(), title: "" };
    }
  }

  async function call(name, args = {}) {
    if (closed) throw new Error("The browser session is closed.");

    switch (name) {
      case "browser_open": {
        const url = normalizeNavigationUrl(args.url, { allowedHosts });
        const tab = args.newTab === true
          ? await createTab()
          : await resolvePage(args.tab, { allowCreate: true });
        const waitUntil = oneOf(
          args.waitUntil,
          ["load", "domcontentloaded", "networkidle0", "networkidle2"],
          "domcontentloaded",
        );
        const timeout = timeoutFor(args.timeoutMs);
        await tab.page.goto(url, { waitUntil, timeout });
        activeTabId = tab.id;

        if (args.includeText === false) {
          const info = await finishNavigationAction(tab.page);
          return textContent(
            `Opened ${info.url}\nTitle: ${info.title}\nTab: ${tab.id}`,
          );
        }

        const summary = await readPageSummary(tab.page, clampText(args.maxChars));
        return textContent(
          `Opened ${summary.url}\nTitle: ${summary.title}\nTab: ${tab.id}\n\n${summary.text}${summary.truncated ? "\n\n[content truncated]" : ""}`,
        );
      }

      case "browser_read": {
        const tab = await resolvePage(args.tab);
        const maxChars = clampText(args.maxChars);
        const format = oneOf(args.format, ["text", "html"], "text");
        const selector = optionalString(args.selector);

        let raw;
        if (selector) {
          const handle = await tab.page.$(selector);
          if (!handle) throw new Error(`No element matches selector: ${selector}`);
          raw = await handle.evaluate(
            (el, fmt) =>
              fmt === "html"
                ? el.outerHTML
                : (el.innerText || el.textContent || "").trim(),
            format,
          );
        } else if (format === "html") {
          raw = await tab.page.evaluate(
            () => (document.documentElement?.outerHTML || "").trim(),
          );
        } else {
          const summary = await readPageSummary(tab.page, maxChars);
          const links =
            args.includeLinks === true
              ? await tab.page.evaluate(() =>
                  [...document.querySelectorAll("a[href]")]
                    .slice(0, 200)
                    .map((anchor) => ({
                      text: (anchor.innerText || "").trim().slice(0, 200),
                      href: anchor.href,
                    })),
                )
              : [];
          const linkBlock = links.length
            ? `\n\nLinks:\n${links
                .map((link) => `- ${link.text || "(no text)"} -> ${link.href}`)
                .join("\n")}`
            : "";
          return textContent(
            `URL: ${summary.url}\nTitle: ${summary.title}\n\n${summary.text}${summary.truncated ? "\n\n[content truncated]" : ""}${linkBlock}`,
          );
        }

        const truncated = raw.length > maxChars;
        const text = raw.slice(0, maxChars);
        const info = await finishNavigationAction(tab.page);
        return textContent(
          `URL: ${info.url}\nTitle: ${info.title}\n\n${text}${truncated ? "\n\n[content truncated]" : ""}`,
        );
      }

      case "browser_snapshot": {
        const tab = await resolvePage(args.tab);
        const maxElements = clampInteger(args.maxElements, 200, 1, 1000);
        const snapshot = await tab.page.evaluate(
          ({ attr, interactiveSelector, limit }) => {
            const isVisible = (el) => {
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
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
            for (const el of document.querySelectorAll(interactiveSelector)) {
              if (elements.length >= limit) break;
              if (!isVisible(el)) continue;

              const tag = el.tagName.toLowerCase();
              const name = clean(
                el.getAttribute("aria-label") ||
                  el.getAttribute("placeholder") ||
                  el.getAttribute("alt") ||
                  el.getAttribute("title") ||
                  el.innerText ||
                  el.value,
              );
              const id = String(++index);
              el.setAttribute(attr, id);
              elements.push({
                id,
                tag,
                type: clean(el.getAttribute("type")) || undefined,
                role: clean(el.getAttribute("role")) || undefined,
                name: name || undefined,
                value:
                  tag === "input" || tag === "textarea" || tag === "select"
                    ? clean(el.value) || undefined
                    : undefined,
                href: tag === "a" ? el.href : undefined,
                checked:
                  el instanceof HTMLInputElement &&
                  (el.type === "checkbox" || el.type === "radio")
                    ? el.checked
                    : undefined,
                disabled: el.disabled === true || undefined,
              });
            }

            return {
              url: location.href,
              title: document.title,
              textPreview: String(document.body?.innerText || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 400),
              elements,
            };
          },
          {
            attr: SNAPSHOT_ATTR,
            interactiveSelector: INTERACTIVE_SELECTOR,
            limit: maxElements,
          },
        );

        return textContent(
          `URL: ${snapshot.url}\nTitle: ${snapshot.title}\nPreview: ${snapshot.textPreview}\n\n${JSON.stringify(snapshot.elements, null, 2)}`,
        );
      }

      case "browser_click": {
        const tab = await resolvePage(args.tab);
        const handle = await findElement(tab.page, args);
        const button = oneOf(
          args.button,
          ["left", "right", "middle"],
          "left",
        );
        const clickCount = clampInteger(args.clickCount, 1, 1, 3);
        const waitAfterMs = clampInteger(args.waitAfterMs, 300, 0, 5_000);

        try {
          if (humanize) {
            await humanClick(
              tab.page,
              mouseStateFor(mouseStates, tab.page),
              handle,
              { button, clickCount },
            );
          } else {
            await handle.evaluate((el) =>
              el.scrollIntoView({ block: "center", inline: "center" }),
            );
            await handle.click({ button, clickCount });
          }
        } catch (error) {
          throw new Error(
            `Click failed: ${error?.message || error}. The element may be covered, detached, or not enabled.`,
          );
        }
        await sleep(waitAfterMs);
        const info = await finishNavigationAction(tab.page);
        return textContent(
          `Clicked element.\nURL: ${info.url}\nTitle: ${info.title}\nTab: ${tab.id}`,
        );
      }

      case "browser_type": {
        const tab = await resolvePage(args.tab);
        const value =
          typeof args.value === "string" ? args.value : undefined;
        if (value === undefined) {
          throw new Error('The "value" argument is required (use "" to clear).');
        }
        const handle = await findElement(tab.page, args);
        const delay = clampInteger(args.delayMs, 0, 0, 1_000);

        await handle.evaluate((el) =>
          el.scrollIntoView({ block: "center", inline: "center" }),
        );
        await handle.focus();
        if (humanize) await settle({ min: 60, max: 180 });

        if (args.clear !== false) {
          const modifier = process.platform === "darwin" ? "Meta" : "Control";
          await tab.page.keyboard.down(modifier);
          await tab.page.keyboard.press("a");
          await tab.page.keyboard.up(modifier);
          await tab.page.keyboard.press("Backspace");
          if (humanize) await settle({ min: 40, max: 120 });
        }

        if (value && humanize) {
          await humanType(tab.page, value, {
            ...(delay > 0
              ? { minDelay: delay, maxDelay: Math.max(delay, delay * 2) }
              : {}),
          });
        } else if (value) {
          await tab.page.keyboard.type(value, { delay });
        }
        if (args.submit === true) {
          if (humanize) await settle({ min: 80, max: 220 });
          await tab.page.keyboard.press("Enter");
        }

        await sleep(clampInteger(args.waitAfterMs, 250, 0, 5_000));
        const info = await finishNavigationAction(tab.page);
        return textContent(
          `Typed into element.${args.submit === true ? " Submitted with Enter." : ""}\nURL: ${info.url}\nTitle: ${info.title}\nTab: ${tab.id}`,
        );
      }

      case "browser_press": {
        const tab = await resolvePage(args.tab);
        const key = requireString(args.key, "key");
        const times = clampInteger(args.times, 1, 1, 20);
        for (let i = 0; i < times; i += 1) {
          await tab.page.keyboard.press(key);
          if (times > 1) {
            if (humanize) await settle({ min: 70, max: 220 });
            else await sleep(50);
          }
        }
        await sleep(150);
        const info = await finishNavigationAction(tab.page);
        return textContent(
          `Pressed ${key}${times > 1 ? ` ${times} times` : ""}.\nURL: ${info.url}\nTitle: ${info.title}`,
        );
      }

      case "browser_scroll": {
        const tab = await resolvePage(args.tab);
        const direction = oneOf(
          args.direction,
          ["up", "down", "top", "bottom"],
          "down",
        );
        const amount = clampInteger(args.amount, 600, 1, 20_000);
        const selector = optionalString(args.selector);

        let position;
        if (humanize) {
          if (selector) {
            await tab.page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (!el) throw new Error(`No element matches selector: ${sel}`);
              el.scrollIntoView({ block: "start", inline: "nearest" });
            }, selector);
            await settle({ min: 180, max: 420 });
          } else {
            let delta = direction === "up" ? -amount : amount;
            if (direction === "top") {
              delta = -(await tab.page.evaluate(() => window.scrollY));
            } else if (direction === "bottom") {
              delta = await tab.page.evaluate(
                () =>
                  document.documentElement.scrollHeight -
                  window.innerHeight -
                  window.scrollY,
              );
            }
            if (delta !== 0) {
              await humanScroll(
                tab.page,
                mouseStateFor(mouseStates, tab.page),
                delta,
              );
            }
          }
          position = await tab.page.evaluate(() => ({
            scrollY: window.scrollY,
            scrollHeight: document.documentElement.scrollHeight,
            viewportHeight: window.innerHeight,
          }));
        } else {
          position = await tab.page.evaluate(
            ({ dir, px, sel }) => {
              if (sel) {
                const el = document.querySelector(sel);
                if (!el) throw new Error(`No element matches selector: ${sel}`);
                el.scrollIntoView({ block: "start", inline: "nearest" });
              } else if (dir === "top") {
                window.scrollTo({ top: 0 });
              } else if (dir === "bottom") {
                window.scrollTo({ top: document.body.scrollHeight });
              } else {
                window.scrollBy({ top: dir === "up" ? -px : px });
              }
              return {
                scrollY: window.scrollY,
                scrollHeight: document.documentElement.scrollHeight,
                viewportHeight: window.innerHeight,
              };
            },
            { dir: direction, px: amount, sel: selector },
          );
        }

        return textContent(
          `Scrolled ${direction}${selector ? ` to ${selector}` : ""}.\nscrollY: ${position.scrollY} / ${Math.max(0, position.scrollHeight - position.viewportHeight)}`,
        );
      }

      case "browser_wait_for": {
        const tab = await resolvePage(args.tab);
        const timeout = timeoutFor(args.timeoutMs);
        const selector = optionalString(args.selector);
        const text = optionalString(args.text);

        if (!selector && !text) {
          throw new Error('Provide "selector" or "text" to wait for.');
        }

        if (selector) {
          const state = oneOf(
            args.state,
            ["attached", "detached", "visible", "hidden"],
            "visible",
          );
          await tab.page.waitForSelector(selector, { timeout, state });
        } else {
          await tab.page.waitForFunction(
            (needle) =>
              (document.body?.innerText || "")
                .toLowerCase()
                .includes(needle),
            { timeout },
            text.toLowerCase(),
          );
        }

        const info = await finishNavigationAction(tab.page);
        return textContent(
          `Wait condition met.\nURL: ${info.url}\nTitle: ${info.title}`,
        );
      }

      case "browser_evaluate": {
        const tab = await resolvePage(args.tab);
        const expression = requireString(args.expression, "expression");
        const result = await tab.page.evaluate(expression);
        const serialized =
          result === undefined
            ? "undefined"
            : JSON.stringify(
                result,
                (key, value) =>
                  typeof value === "bigint" ? value.toString() : value,
                2,
              );
        return textContent(`Result:\n${serialized}`);
      }

      case "browser_screenshot": {
        const tab = await resolvePage(args.tab);
        const type = oneOf(args.format, ["png", "jpeg"], "png");
        const options = {
          type,
          fullPage: args.fullPage === true,
          encoding: "base64",
        };
        if (type === "jpeg") {
          options.quality = clampInteger(args.quality, 80, 1, 100);
        }
        const data = await tab.page.screenshot(options);
        const info = await finishNavigationAction(tab.page);
        return {
          content: [
            {
              type: "text",
              text: `Screenshot of ${info.url} (${info.title || "untitled"}, tab ${tab.id})`,
            },
            {
              type: "image",
              data,
              mimeType: type === "jpeg" ? "image/jpeg" : "image/png",
            },
          ],
        };
      }

      case "browser_tabs": {
        const pages = [];
        for (const [id, entry] of tabs) {
          let url = "";
          let title = "";
          try {
            url = entry.page.url();
            title = await entry.page.title();
          } catch {
            // Tab may be closing.
          }
          pages.push({ id, url, title, active: id === activeTabId });
        }

        if (!pages.length) return textContent("No tabs open.");
        return textContent(
          pages
            .map(
              (tab) =>
                `${tab.active ? "*" : " "} ${tab.id}: ${tab.title || "(untitled)"} - ${tab.url}`,
            )
            .join("\n"),
        );
      }

      case "browser_switch_tab": {
        const tab = await resolveTab(args.tab);
        activeTabId = tab.id;
        const info = await finishNavigationAction(tab.page);
        return textContent(
          `Active tab: ${tab.id}\nURL: ${info.url}\nTitle: ${info.title}`,
        );
      }

      case "browser_close_tab": {
        const tab = await resolveTab(args.tab);
        await tab.page.close();
        tabs.delete(tab.id);
        if (activeTabId === tab.id) {
          activeTabId = tabs.size ? [...tabs.keys()].at(-1) : null;
        }
        return textContent(
          `Closed ${tab.id}. Remaining tabs: ${tabs.size ? [...tabs.keys()].join(", ") : "(none)"}`,
        );
      }

      case "browser_history": {
        const tab = await resolvePage(args.tab);
        const action = oneOf(
          args.action,
          ["back", "forward", "reload"],
          "back",
        );
        const timeout = timeoutFor(args.timeoutMs);
        if (action === "back") await tab.page.goBack({ timeout });
        else if (action === "forward") await tab.page.goForward({ timeout });
        else await tab.page.reload({ timeout });

        await sleep(150);
        const info = await finishNavigationAction(tab.page);
        return textContent(
          `${action} complete.\nURL: ${info.url}\nTitle: ${info.title}\nTab: ${tab.id}`,
        );
      }

      case "browser_close": {
        await closeBrowser();
        return textContent(
          "Browser closed. All tabs were discarded; the next browser_open starts a fresh browser session.",
        );
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async function closeBrowser() {
    activeTabId = null;
    const pages = [...tabs.values()].map((entry) => entry.page);
    tabs.clear();

    if (context) {
      const current = context;
      context = null;
      contextPromise = null;
      try {
        await current.close();
      } catch {
        // Ignore shutdown errors.
      }
    } else if (external) {
      for (const page of pages) {
        try {
          await page.close();
        } catch {
          // Ignore already-closed pages.
        }
      }
    }

    if (ownsBrowser) {
      const instance = browser;
      browser = null;
      browserPromise = null;
      if (instance) {
        try {
          await instance.close();
        } catch {
          // Ignore shutdown errors.
        }
      }
    }
  }

  async function dispose() {
    closed = true;
    await closeBrowser();
  }

  return {
    call,
    close: dispose,
    reset: closeBrowser,
    get closed() {
      return closed;
    },
    get tabCount() {
      return tabs.size;
    },
  };
}
