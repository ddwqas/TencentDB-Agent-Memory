/**
 * FileLogger — 按本地日期追加的业务日志写入器。
 *
 * 功能：
 * - 批量同步追加，避免关闭进程时留下未完成的流写入
 * - 缓冲后定期批量刷新
 * - 按本地日期追加，同日重启不覆盖
 * - 保留历史日期日志，不自动清理
 * - 日志错误不影响业务
 */

import fs from "node:fs";
import path from "node:path";
import { formatLocalLogTime } from "./log-time.js";
import { writeStderrLog } from "./stderr-log.js";

export interface FileLoggerConfig {
  /** Log file directory. Empty disables file logging. */
  dir: string;
  /** Log file name (e.g. "proxy.log"). */
  filename: string;
  /** 兼容旧配置；当前按日期轮转。 */
  rotateSizeBytes?: number;
  /** 兼容旧配置；历史日期日志保留。 */
  rotateBackupLimit?: number;
  /** Buffer flush interval in ms (default: 200ms). */
  flushIntervalMs?: number;
  /** Buffer flush threshold in lines (default: 50). */
  flushThreshold?: number;
}

/**
 * 按日志产生日期保存结构化日志，保留历史文件。
 */
export class FileLogger {
  private readonly dir: string;
  private readonly filename: string;
  private readonly flushThreshold: number;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private disabled = false;
  private day = '';

  constructor(cfg: FileLoggerConfig) {
    this.dir = cfg.dir;
    this.filename = cfg.filename.replace(/\.log$/i, '');
    this.flushThreshold = cfg.flushThreshold ?? 50;
    if (!this.dir) { this.disabled = true; return; }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.flushTimer = setInterval(() => this.flush(), cfg.flushIntervalMs ?? 200);
      this.flushTimer.unref();
    } catch (error) { this.disabled = true; writeStderrLog('[file-logger] init failed: ' + String(error)); }
  }

  /** 日期改变前先将旧日缓冲写完，防止午夜附近的日志落入错误日期。 */
  public write(level: string, message: string, data?: Record<string, unknown>): void {
    if (this.disabled) return;
    try {
      const timestamp = formatLocalLogTime();
      const day = timestamp.slice(0, 10);
      if (day !== this.day) { this.flush(); this.day = day; }
      const sorted = data ? Object.fromEntries(Object.keys(data).sort().map((key) => [key, data[key]])) : null;
      this.buffer.push('[' + timestamp + '][' + level + '] ' + message + (sorted && Object.keys(sorted).length ? ' ' + JSON.stringify(sorted) : '') + '\n');
      if (this.buffer.length >= this.flushThreshold) this.flush();
    } catch { /* 日志格式错误不影响业务。 */ }
  }

  public flush(): void {
    if (!this.buffer.length || this.disabled) return;
    try {
      fs.appendFileSync(path.join(this.dir, this.filename + '_' + this.day + '.log'), this.buffer.join(''), 'utf8');
      this.buffer = [];
    } catch (error) { this.disabled = true; this.buffer = []; writeStderrLog('[file-logger] write failed: ' + String(error)); }
  }

  public async shutdown(): Promise<void> {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    this.flush();
  }
}
