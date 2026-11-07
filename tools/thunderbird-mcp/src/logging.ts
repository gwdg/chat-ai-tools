let debugEnabled = false;

export function setDebugEnabled(value: boolean): void {
  debugEnabled = value;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

function timestamp(): string {
  return new Date().toISOString();
}

export function debugLog(message: string): void {
  if (!debugEnabled) return;
  process.stderr.write(`[thunderbird-mcp] ${timestamp()} DEBUG ${message}\n`);
}

export function logError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    debugEnabled && error instanceof Error && error.stack ? `\n${error.stack}` : "";
  process.stderr.write(
    `[thunderbird-mcp] ${timestamp()} ERROR ${context}: ${message}${detail}\n`,
  );
}
