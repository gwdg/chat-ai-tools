let debugEnabled = false;

export function setDebugEnabled(value: boolean): void {
  debugEnabled = value;
}

function write(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function debugLog(message: string): void {
  if (!debugEnabled) return;
  write(`[crm-mcp] ${new Date().toISOString()} DEBUG ${message}`);
}

export function logError(message: string, error: unknown): void {
  const text =
    error instanceof Error
      ? `${error.message}${debugEnabled && error.stack ? `\n${error.stack}` : ""}`
      : String(error);
  write(`[crm-mcp] ${new Date().toISOString()} ERROR ${message}: ${text}`);
}
