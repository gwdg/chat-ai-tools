const form = document.getElementById("form");
const relayUrlInput = document.getElementById("relayUrl");
const tokenInput = document.getElementById("extensionToken");
const statusElement = document.getElementById("status");
const disconnectButton = document.getElementById("disconnect");

function renderStatus(status) {
  if (!status) {
    statusElement.textContent = "Unknown";
    return;
  }
  if (status.connection === "connected") {
    statusElement.textContent = `Connected to ${status.relayUrl || "the relay"}`;
  } else if (status.connection === "connecting") {
    statusElement.textContent = `Connecting to ${status.relayUrl || "the relay"}…`;
  } else if (status.connection === "disabled") {
    statusElement.textContent = "Disconnected. Save and connect to enable.";
  } else if (status.connection === "error") {
    statusElement.textContent = `Error: ${status.error || "connection failed"}`;
  } else {
    statusElement.textContent = "Disconnected";
  }
}

async function refreshStatus() {
  const response = await chrome.runtime.sendMessage({ type: "status" });
  renderStatus(response?.status);
}

async function load() {
  const stored = await chrome.storage.local.get([
    "relayUrl",
    "extensionToken",
  ]);
  relayUrlInput.value = stored.relayUrl || "ws://127.0.0.1:8766/extension";
  tokenInput.value = stored.extensionToken || "";
  await refreshStatus();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const relayUrl = relayUrlInput.value.trim();
  if (!/^wss?:\/\//i.test(relayUrl)) {
    statusElement.textContent = "Use a ws:// or wss:// URL.";
    return;
  }
  await chrome.storage.local.set({
    relayUrl,
    extensionToken: tokenInput.value.trim(),
    enabled: true,
  });
  await chrome.runtime.sendMessage({ type: "reconnect" });
  statusElement.textContent = "Saved. Connecting…";
  setTimeout(refreshStatus, 500);
});

disconnectButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  setTimeout(refreshStatus, 200);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "status") renderStatus(message.status);
});

void load();
