/**
 * Logger — simple leveled logging module
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || "debug") as Level;

function ts() {
  const date = new Date();
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  const millisecond = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${millisecond}`;
}

function shouldLog(level: Level) {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[LOG_LEVEL];
}

function format(level: Level, tag: string, msg: string, data?: unknown) {
  const prefix = `${ts()} [${level.toUpperCase().padEnd(5)}] [${tag}]`;
  if (data !== undefined) {
    return `${prefix} ${msg} ${JSON.stringify(data, null, 0)}`;
  }
  return `${prefix} ${msg}`;
}

export function createLogger(tag: string) {
  return {
    debug(msg: string, data?: unknown) {
      if (shouldLog("debug")) console.log(format("debug", tag, msg, data));
    },
    info(msg: string, data?: unknown) {
      if (shouldLog("info")) console.log(format("info", tag, msg, data));
    },
    warn(msg: string, data?: unknown) {
      if (shouldLog("warn")) console.warn(format("warn", tag, msg, data));
    },
    error(msg: string, data?: unknown) {
      if (shouldLog("error")) console.error(format("error", tag, msg, data));
    },
  };
}

export const log = createLogger("app");
