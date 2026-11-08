const params = new URLSearchParams(location.search);
const id = params.get("id");

const purpose = document.getElementById("purpose");
const title = document.getElementById("title");
const origin = document.getElementById("origin");
const url = document.getElementById("url");
const error = document.getElementById("error");
const buttons = {
  deny: document.getElementById("deny"),
  once: document.getElementById("once"),
  session: document.getElementById("session"),
};

let loaded = false;

function showError(message) {
  error.hidden = false;
  error.textContent = message;
}

function disableButtons() {
  for (const button of Object.values(buttons)) button.disabled = true;
}

async function load() {
  if (!id) {
    showError("This confirmation request is invalid.");
    disableButtons();
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "confirmation-details",
      id,
    });
    if (!response?.ok) {
      showError(response?.error || "This confirmation is no longer pending.");
      disableButtons();
      return;
    }
    const { details } = response;
    purpose.textContent = details.purpose || "An MCP client wants to access this tab.";
    title.textContent = details.title || "(untitled)";
    origin.textContent = details.origin || "";
    url.textContent = details.url || "";
    loaded = true;
  } catch (caught) {
    showError(
      caught instanceof Error ? caught.message : "Could not load this request.",
    );
    disableButtons();
  }
}

async function choose(choice) {
  if (!loaded) return;
  disableButtons();
  try {
    await chrome.runtime.sendMessage({
      type: "confirmation-choice",
      id,
      choice,
    });
  } finally {
    window.close();
  }
}

for (const [choice, button] of Object.entries(buttons)) {
  button.addEventListener("click", () => {
    void choose(choice);
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    void choose("deny");
  }
});

void load();
