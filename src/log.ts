export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel): Logger {
  const write = (current: LogLevel, message: string, extra?: Record<string, unknown>): void => {
    if (RANK[current] < RANK[level]) return;
    const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
    console.error(`[agent-memory] ${current} ${message}${suffix}`);
  };

  return {
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
}

let sqliteWarningHooked = false;

/**
 * node:sqlite emits an experimental warning on first use. Node 22 registers a
 * default listener that prints it, so adding another listener is not enough.
 * Keep stderr usable as the MCP log stream.
 */
export function silenceSqliteExperimentalWarning(): void {
  if (sqliteWarningHooked) return;
  sqliteWarningHooked = true;
  const existing = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
    for (const listener of existing) listener(warning);
  });
}
