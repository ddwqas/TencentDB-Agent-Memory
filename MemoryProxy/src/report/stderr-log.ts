import { formatLocalLogTime } from "./log-time.js";

export function writeStderrLog(message: string): void {
  process.stderr.write(`${formatLocalLogTime()} ${message}\n`);
}
