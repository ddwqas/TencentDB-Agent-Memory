import { format } from "node:util";
import { formatLocalLogTime } from "./log-time.js";

type ConsoleMethod = (...args: unknown[]) => void;
type ConsoleTarget = Pick<Console, "log" | "info" | "warn" | "error" | "debug">;
type ConsoleMethodName = keyof ConsoleTarget;

const METHOD_NAMES: ConsoleMethodName[] = ["log", "info", "warn", "error", "debug"];

export function installConsoleLogTime(target: ConsoleTarget = console): void {
  for (const methodName of METHOD_NAMES) {
    const write = target[methodName].bind(target) as ConsoleMethod;
    target[methodName] = ((...args: unknown[]) => {
      write(`${formatLocalLogTime()} ${format(...args)}`);
    }) as Console[ConsoleMethodName];
  }
}
