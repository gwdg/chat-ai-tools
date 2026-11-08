const statusElement = document.getElementById("status");
const detailElement = document.getElementById("detail");
const toggleButton = document.getElementById("toggle");
const settingsButton = document.getElementById("settings");
const revokeButton = document.getElementById("revoke");

let currentStatus = null;

function render(status) {
  currentStatus = status;
  statusElement.className = "status";
  if (!status) {
    statusElement.textContent = "Unknown status";
    detailElement.textContent = "";
    return;
  }

  if (status.connection === "connected") {
    statusElement.textContent = "Connected";
    statusElement.classList.add("connected");
    detailElement.textContent = `${status.relayUrl || ""}${
      status.relayVersion ? ` · relay ${status.relayVersion}` : ""
    }`;
    toggleButton.textContent = "Disconnect";
  } else if (status.connection === "disabled") {
    statusElement.textContent = "Disconnected";
    detailElement.textContent = "The extension will not connect until enabled.";
    toggleButton.textContent = "Connect";
  } else if (status.connection === "connecting") {
    statusElement.textContent = "Connecting…";
    detailElement.textContent = status.relayUrl || "";
    toggleButton.textContent = "Disconnect";
  } else if (status.connection === "error") {
    statusElement.textContent = "Connection error";
    statusElement.classList.add("error");
    detailElement.textContent = status.error || status.relayUrl || "";
    toggleButton.textContent = "Reconnect";
  } else {
    statusElement.textContent = "Disconnected";
    detailElement.textContent = status.relayUrl || "";
    toggleButton.textContent = "Connect";
  }
}

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: "status" });
  render(response?.status);
}

toggleButton.addEventListener("click", async () => {
  const connected =
    currentStatus?.connection === "connected" ||
    currentStatus?.connection === "connecting";
  await chrome.runtime.sendMessage({
    type: connected ? "disconnect" : "connect",
  });
  setTimeout(refresh, 200);
});

settingsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

revokeButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "revoke-grants" });
  revokeButton.textContent = "Session grants revoked";
  setTimeout(() => {
    revokeButton.textContent = "Revoke session grants";
  }, 1500);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "status") render(message.status);
});

void refresh();
