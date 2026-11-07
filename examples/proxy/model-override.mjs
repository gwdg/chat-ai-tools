// Applies the model configured on the server to a chat completion request.
// Keeping this pure makes it testable without starting the proxy.

export function applyBackendModel(rawBody, model) {
  if (!model) return rawBody;

  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON request body");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JSON request body");
  }

  parsed.model = model;
  return Buffer.from(JSON.stringify(parsed));
}
