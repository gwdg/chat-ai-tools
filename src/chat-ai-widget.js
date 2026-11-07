// <chat-ai-widget> — a small, dependency-free chat widget for Chat AI / SAIA.
//
// Usage:
//   <chat-ai-widget></chat-ai-widget>
//   <script type="module" src="/src/chat-ai-widget.js"></script>
//   <script type="module">
//     const widget = document.querySelector("chat-ai-widget");
//     await customElements.whenDefined("chat-ai-widget");
//     widget.configure({
//       endpoint: "http://127.0.0.1:8081",
//       model: "qwen3-30b-a3b-instruct-2507",
//       systemPrompt: "You are a helpful assistant.",
//     });
//   </script>

import { ChatAIClient } from "./chat-ai-client.js";

const DEFAULTS = {
  endpoint: "http://127.0.0.1:8081",
  model: "",
  systemPrompt: "",
  aiDisclosure:
    "You are chatting with an AI assistant. Responses are generated automatically and may be inaccurate.",
  aiIconAlt: "AI-generated content",
  privacyLinkLabel: "Data privacy",
  privacyDetails:
    "This chatbot sends the messages you enter to the configured AI endpoint for processing. The conversation is kept only in this page's memory and is not stored by this widget.\n\nDo not enter personal, confidential, or sensitive information. The operator of this page and the AI provider may process the messages according to their own policies.",
  temperature: 0.5,
  topP: 0.8,
  maxTokens: 1024,
  token: "",
  serviceName: "",
  title: "SAIA Assistant",
  welcome: "Hello! How can I help you today?",
  placeholder: "Type your message…",
  height: "32rem",
  popup: false,
};

const ATTRIBUTE_KEYS = {
  endpoint: "endpoint",
  model: "model",
  "system-prompt": "systemPrompt",
  "ai-disclosure": "aiDisclosure",
  "ai-icon-alt": "aiIconAlt",
  "privacy-link-label": "privacyLinkLabel",
  "privacy-details": "privacyDetails",
  token: "token",
  "service-name": "serviceName",
  title: "title",
  welcome: "welcome",
  placeholder: "placeholder",
  height: "height",
};

const STYLES = `
  :host {
    --chat-accent: #b4388d;
    --chat-accent-contrast: #ffffff;
    --chat-bg: #ffffff;
    --chat-surface: #f7f5f9;
    --chat-border: #e3dce8;
    --chat-text: #241c2b;
    --chat-muted: #6b6072;
    --chat-user: #f1e6ef;
    --chat-assistant: #f5f3f7;
    display: block;
    color: var(--chat-text);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }

  @media (prefers-color-scheme: dark) {
    :host {
      --chat-accent: #d75aa8;
      --chat-bg: #1b1620;
      --chat-surface: #251e2b;
      --chat-border: #3a3042;
      --chat-text: #f2edf5;
      --chat-muted: #b5a9bd;
      --chat-user: #3a2635;
      --chat-assistant: #2a2230;
    }
  }

  .widget {
    display: flex;
    flex-direction: column;
    height: var(--chat-height, 32rem);
    overflow: hidden;
    border: 1px solid var(--chat-border);
    border-radius: 16px;
    background: var(--chat-bg);
    box-shadow: 0 10px 30px rgb(36 28 43 / 10%);
  }

  .header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--chat-border);
    background: var(--chat-surface);
  }

  .header-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 650;
  }

  .header .reset {
    border: 1px solid var(--chat-border);
    border-radius: 999px;
    background: transparent;
    color: var(--chat-muted);
    cursor: pointer;
    font: inherit;
    font-size: 0.78rem;
    padding: 0.25rem 0.65rem;
  }

  .header .reset:hover {
    color: var(--chat-text);
    border-color: var(--chat-accent);
  }

  .messages {
    flex: 1;
    margin: 0;
    padding: 1rem;
    overflow-y: auto;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .notice {
    margin: 0;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--chat-border);
    background: color-mix(in oklab, var(--chat-surface) 82%, transparent);
    color: var(--chat-muted);
    font-size: 0.76rem;
    line-height: 1.4;
  }

  .notice p {
    margin: 0;
  }

  .privacy-link {
    flex: none;
    padding: 0;
    border: 0;
    background: none;
    color: var(--chat-accent);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .privacy-link:hover {
    color: var(--chat-text);
  }

  .ai-icon {
    display: block;
    flex: none;
    width: auto;
    height: 1.75rem;
  }

  .ai-icon-dark {
    display: none;
  }

  @media (prefers-color-scheme: dark) {
    .ai-icon-light {
      display: none;
    }

    .ai-icon-dark {
      display: block;
    }
  }

  .privacy-dialog {
    max-width: min(34rem, calc(100vw - 2rem));
    padding: 1.25rem;
    border: 1px solid var(--chat-border);
    border-radius: 16px;
    background: var(--chat-bg);
    color: var(--chat-text);
    box-shadow: 0 20px 60px rgb(0 0 0 / 25%);
  }

  .privacy-dialog::backdrop {
    background: rgb(0 0 0 / 45%);
  }

  .privacy-dialog-title {
    margin: 0 0 0.75rem;
    font-size: 1.05rem;
  }

  .privacy-dialog-body {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .privacy-dialog-body p {
    margin: 0;
  }

  .privacy-dialog-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .privacy-close {
    border: 0;
    border-radius: 10px;
    background: var(--chat-accent);
    color: var(--chat-accent-contrast);
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: 0.5rem 0.9rem;
  }

  .welcome {
    padding: 0.65rem 0.8rem;
    border-radius: 12px;
    background: var(--chat-assistant);
    color: var(--chat-muted);
    font-size: 0.9rem;
  }

  .message {
    display: flex;
    max-width: 100%;
  }

  .message.user {
    justify-content: flex-end;
  }

  .bubble {
    max-width: min(85%, 42rem);
    padding: 0.6rem 0.8rem;
    border-radius: 14px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .message.user .bubble {
    background: var(--chat-user);
    border-bottom-right-radius: 4px;
  }

  .message.assistant .bubble {
    background: var(--chat-assistant);
    border-bottom-left-radius: 4px;
  }

  .composer {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    padding: 0.75rem;
    border-top: 1px solid var(--chat-border);
    background: var(--chat-surface);
  }

  textarea {
    flex: 1;
    min-height: 2.5rem;
    max-height: 7.5rem;
    resize: none;
    border: 1px solid var(--chat-border);
    border-radius: 12px;
    background: var(--chat-bg);
    color: var(--chat-text);
    font: inherit;
    padding: 0.55rem 0.7rem;
  }

  textarea:focus {
    outline: 2px solid color-mix(in oklab, var(--chat-accent) 55%, transparent);
    outline-offset: 1px;
  }

  .send,
  .stop {
    border: 0;
    border-radius: 12px;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: 0.55rem 0.9rem;
  }

  .send {
    background: var(--chat-accent);
    color: var(--chat-accent-contrast);
  }

  .send:disabled {
    cursor: wait;
    opacity: 0.6;
  }

  .stop {
    background: var(--chat-border);
    color: var(--chat-text);
  }

  .status {
    min-height: 1.25rem;
    margin: 0;
    padding: 0 1rem 0.5rem;
    color: var(--chat-muted);
    font-size: 0.78rem;
  }

  .shell {
    display: block;
  }

  .launcher {
    display: none;
    align-items: center;
    justify-content: center;
    width: 3.5rem;
    height: 3.5rem;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--chat-accent);
    color: var(--chat-accent-contrast);
    box-shadow: 0 10px 30px rgb(0 0 0 / 25%);
    cursor: pointer;
    z-index: 10001;
  }

  .shell.popup .launcher {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    display: inline-flex;
  }

  .launcher:focus-visible {
    outline: 3px solid var(--chat-bg);
    outline-offset: 2px;
    box-shadow: 0 0 0 5px var(--chat-accent);
  }

  .launcher svg {
    width: 1.75rem;
    height: 1.75rem;
  }

  .launcher-close {
    display: none;
  }

  .launcher[data-open="true"] .launcher-open {
    display: none;
  }

  .launcher[data-open="true"] .launcher-close {
    display: block;
  }

  .shell.popup .widget {
    position: fixed;
    right: 1rem;
    bottom: 5rem;
    width: min(24rem, calc(100vw - 2rem));
    height: min(var(--chat-height, 32rem), calc(100vh - 7rem));
    z-index: 10000;
    box-shadow: 0 20px 60px rgb(0 0 0 / 25%);
  }

  .shell.popup .widget[hidden] {
    display: none;
  }

`;

const TEMPLATE = `
  <div class="shell">
    <section class="widget" id="chat-widget-panel">
      <header class="header">
        <div class="header-title">
          <h2 class="title">SAIA Assistant</h2>
          <img class="ai-icon ai-icon-light" alt="" />
          <img class="ai-icon ai-icon-dark" alt="" />
          <button
            type="button"
            class="privacy-link"
            aria-haspopup="dialog"
            aria-controls="privacy-dialog"
          ></button>
        </div>
        <button type="button" class="reset" title="Start a new conversation">New chat</button>
      </header>
      <aside class="notice" role="note">
        <p class="notice-ai"></p>
      </aside>
      <div class="welcome"></div>
      <ol class="messages" aria-live="polite"></ol>
      <form class="composer">
        <textarea rows="1" aria-label="Message"></textarea>
        <button type="submit" class="send">Send</button>
        <button type="button" class="stop" hidden>Stop</button>
      </form>
      <p class="status" role="status"></p>
      <dialog
        class="privacy-dialog"
        id="privacy-dialog"
        aria-labelledby="privacy-dialog-title"
      >
        <h3 class="privacy-dialog-title" id="privacy-dialog-title"></h3>
        <div class="privacy-dialog-body"></div>
        <div class="privacy-dialog-actions">
          <button type="button" class="privacy-close">Close</button>
        </div>
      </dialog>
    </section>
    <button
      type="button"
      class="launcher"
      aria-label="Open chat"
      aria-expanded="false"
      aria-controls="chat-widget-panel"
      title="Open chat"
    >
      <svg class="launcher-open" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
          fill="currentColor"
        />
      </svg>
      <svg class="launcher-close" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M6 9l6 6 6-6"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>
`;

export class ChatAIWidget extends HTMLElement {
  static get observedAttributes() {
    return [...Object.keys(ATTRIBUTE_KEYS), "popup"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { ...DEFAULTS };
    this._messages = [];
    this._controller = null;
    this._streaming = false;
    this._popupOpen = false;
    this._generation = 0;
    this._build();
  }

  connectedCallback() {
    this._applyAttributes();
    this._reset();
  }

  disconnectedCallback() {
    this._abort();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    if (name === "popup" && newValue === null) this._config.popup = false;
    this._applyAttributes();
    this._reset();
  }

  /**
   * Merge configuration and start a fresh conversation.
   * Call after customElements.whenDefined("chat-ai-widget").
   */
  configure(config = {}) {
    this._config = { ...this._config, ...config };
    this._reset();
    return this;
  }

  /** Clear the conversation without changing the configuration. */
  reset() {
    this._reset();
  }

  /** Send a message programmatically. */
  send(text) {
    const value = String(text || "").trim();
    if (!value) return;
    this._el.input.value = value;
    return this._send();
  }

  _applyAttributes() {
    for (const [attribute, key] of Object.entries(ATTRIBUTE_KEYS)) {
      const value = this.getAttribute(attribute);
      if (value !== null) this._config[key] = value;
    }

    if (this.hasAttribute("popup")) {
      this._config.popup = this.getAttribute("popup") !== "false";
    }
  }

  _build() {
    const style = document.createElement("style");
    style.textContent = STYLES;

    const container = document.createElement("div");
    container.innerHTML = TEMPLATE;
    const shell = container.firstElementChild;
    const wrapper = shell.querySelector(".widget");
    const launcher = shell.querySelector(".launcher");

    this.shadowRoot.append(style, shell);

    this._el = {
      shell,
      widget: wrapper,
      launcher,
      title: wrapper.querySelector(".title"),
      noticeAi: wrapper.querySelector(".notice-ai"),
      privacyLink: wrapper.querySelector(".privacy-link"),
      privacyDialog: wrapper.querySelector(".privacy-dialog"),
      privacyDialogTitle: wrapper.querySelector(".privacy-dialog-title"),
      privacyDialogBody: wrapper.querySelector(".privacy-dialog-body"),
      privacyClose: wrapper.querySelector(".privacy-close"),
      aiIconLight: wrapper.querySelector(".ai-icon-light"),
      aiIconDark: wrapper.querySelector(".ai-icon-dark"),
      welcome: wrapper.querySelector(".welcome"),
      messages: wrapper.querySelector(".messages"),
      form: wrapper.querySelector(".composer"),
      input: wrapper.querySelector("textarea"),
      send: wrapper.querySelector(".send"),
      stop: wrapper.querySelector(".stop"),
      reset: wrapper.querySelector(".reset"),
      status: wrapper.querySelector(".status"),
    };

    const iconUrl = (file) =>
      new URL(`../assets/eu-ai-icons/${file}`, import.meta.url).href;
    this._el.aiIconLight.src = iconUrl("label-ai-generated-black.svg");
    this._el.aiIconDark.src = iconUrl("label-ai-generated-white.svg");

    this._el.privacyLink.addEventListener("click", () =>
      this._openPrivacyDialog(),
    );
    this._el.privacyClose.addEventListener("click", () =>
      this._closePrivacyDialog(),
    );
    this._el.privacyDialog.addEventListener("click", (event) => {
      if (event.target === this._el.privacyDialog) this._closePrivacyDialog();
    });
    this._el.launcher.addEventListener("click", () => this._togglePopup());

    this._el.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this._send();
    });

    this._el.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this._send();
      }
    });

    this._el.input.addEventListener("input", () => this._autosize());
    this._el.stop.addEventListener("click", () => this._abort());
    this._el.reset.addEventListener("click", () => this._reset());
  }

  _reset() {
    this._generation += 1;
    this._closePrivacyDialog();
    this._abort();
    this._messages = [];
    this._setStreaming(false);

    this._el.title.textContent = this._config.title;
    const aiIconAlt = this._config.aiIconAlt || DEFAULTS.aiIconAlt;
    this._el.aiIconLight.alt = aiIconAlt;
    this._el.aiIconDark.alt = aiIconAlt;

    this._el.noticeAi.textContent =
      this._config.aiDisclosure || DEFAULTS.aiDisclosure;
    const privacyLabel =
      this._config.privacyLinkLabel || DEFAULTS.privacyLinkLabel;
    this._el.privacyLink.textContent = privacyLabel;
    this._el.privacyDialogTitle.textContent = privacyLabel;
    this._renderPrivacyDetails();
    this._el.welcome.textContent = this._config.welcome;
    this._el.welcome.hidden = !this._config.welcome;
    this._el.input.placeholder = this._config.placeholder;
    this._el.input.value = "";
    this._el.messages.replaceChildren();
    this._el.status.textContent = "";
    this._el.widget.style.setProperty("--chat-height", this._config.height);
    this._autosize();
    this._applyPopupMode();
  }

  _applyPopupMode() {
    const popup = Boolean(this._config.popup);
    this._el.shell.classList.toggle("popup", popup);
    if (!popup) this._popupOpen = false;

    this._el.launcher.hidden = !popup;
    this._el.widget.hidden = popup && !this._popupOpen;
    this._updateLauncher();
  }

  _updateLauncher() {
    if (!this._config.popup) return;

    const open = this._popupOpen;
    this._el.launcher.dataset.open = open ? "true" : "false";
    this._el.launcher.setAttribute("aria-expanded", String(open));

    const label = `${open ? "Minimize" : "Open"} ${this._config.title}`;
    this._el.launcher.setAttribute("aria-label", label);
    this._el.launcher.title = label;
  }

  _togglePopup() {
    if (!this._config.popup) return;

    this._popupOpen = !this._popupOpen;
    if (!this._popupOpen) this._closePrivacyDialog();
    this._applyPopupMode();

    if (this._popupOpen) this._el.input.focus();
  }

  _appendMessage(role, text) {
    const item = document.createElement("li");
    item.className = `message ${role}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;

    item.append(bubble);
    this._el.messages.append(item);
    this._scroll();

    return { item, bubble };
  }

  _renderPrivacyDetails() {
    const details = String(
      this._config.privacyDetails || DEFAULTS.privacyDetails,
    );
    const paragraphs = details
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    this._el.privacyDialogBody.replaceChildren(
      ...paragraphs.map((text) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = text;
        return paragraph;
      }),
    );
  }

  _openPrivacyDialog() {
    const dialog = this._el.privacyDialog;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  _closePrivacyDialog() {
    const dialog = this._el.privacyDialog;
    if (!dialog) return;
    if (typeof dialog.close === "function") {
      if (dialog.open) dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }

  async _send() {
    const text = this._el.input.value.trim();
    if (!text || this._streaming) return;

    this._el.input.value = "";
    this._autosize();
    this._el.welcome.hidden = true;

    this._messages.push({ role: "user", content: text });
    this._appendMessage("user", text);

    const assistant = this._appendMessage("assistant", "");
    const controller = new AbortController();
    const generation = this._generation;
    this._controller = controller;
    this._setStreaming(true);
    this._el.status.textContent = "Thinking…";

    let received = "";
    try {
      const client = new ChatAIClient({
        endpoint: this._config.endpoint,
        token: this._config.token,
        serviceName: this._config.serviceName,
      });

      const history = [
        ...(this._config.systemPrompt
          ? [{ role: "system", content: this._config.systemPrompt }]
          : []),
        ...this._messages,
      ];

      for await (const token of client.streamChat(history, {
        model: this._config.model,
        temperature: Number(this._config.temperature),
        topP: Number(this._config.topP),
        maxTokens: Number(this._config.maxTokens),
        signal: controller.signal,
      })) {
        received += token;
        assistant.bubble.textContent = received;
        this._scroll();
      }

      if (generation !== this._generation) return;
      if (!received) assistant.bubble.textContent = "(No response.)";
      this._messages.push({ role: "assistant", content: received });
      this._el.status.textContent = "";
    } catch (error) {
      if (generation !== this._generation) return;
      if (received) {
        this._messages.push({ role: "assistant", content: received });
      } else {
        assistant.item.remove();
      }

      if (error?.name === "AbortError") {
        this._el.status.textContent = "Stopped.";
      } else {
        this._el.status.textContent = error?.message || String(error);
      }
    } finally {
      this._controller = null;
      this._setStreaming(false);
      if (!this._config.popup || this._popupOpen) this._el.input.focus();
    }
  }

  _abort() {
    if (this._controller) {
      this._controller.abort();
      this._controller = null;
    }
    this._setStreaming(false);
  }

  _setStreaming(streaming) {
    this._streaming = streaming;
    this._el.send.disabled = streaming;
    this._el.input.disabled = streaming;
    this._el.stop.hidden = !streaming;
  }

  _autosize() {
    const input = this._el.input;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }

  _scroll() {
    this._el.messages.scrollTop = this._el.messages.scrollHeight;
  }
}

if (!customElements.get("chat-ai-widget")) {
  customElements.define("chat-ai-widget", ChatAIWidget);
}

export default ChatAIWidget;
