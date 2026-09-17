/**
 * file-logger.ts — 本地日志文件写入器
 *
 * 将日志双写到本地文件，支持：
 * - 按本地日期轮转，同日重启追加
 * - 保留已有日期的日志
 * - 目录自动创建
 * - 错误静默处理（不影响主业务流程）
 *
 * 使用同步文件写入（appendFileSync），避免 WriteStream 导致进程无法退出。
 * 日志写入量小且不频繁，同步开销可忽略。
 */

import fs from "node:fs";
import path from "node:path";
import { formatLocalLogTime } from "../../utils/log-time.js";

export interface FileLoggerConfig {
  /** 日志文件目录，如 /data/log/。为空时禁用文件写入。 */
  path: string;
  /** 日志文件名，如 core.log */
  filename: string;
  /** 兼容旧配置；当前使用按日轮转。 */
  rotateSizeBytes: number;
  /** 兼容旧配置；不自动删除历史日期日志。 */
  rotateBackupLimit: number;
}

/**
 * FileLogger 本地日志文件写入器。
 * 按本地日期追加写入，保留同日重启前及历史日期的日志。
 */
export class FileLogger {
  private disabled = false;

  constructor(private readonly cfg: FileLoggerConfig) {
    if (!cfg.path) { this.disabled = true; return; }
    try { fs.mkdirSync(cfg.path, { recursive: true }); }
    catch (error) { this.disabled = true; process.stderr.write('[file-logger] init failed: ' + String(error) + '\n'); }
  }

  /** 按日志产生时的本地日期追加，不删除历史日期文件。 */
  public write(level: string, message: string, data?: Record<string, unknown>): void {
    if (this.disabled) return;
    try {
      const timestamp = formatLocalLogTime();
      const stem = this.cfg.filename.replace(/\.log$/i, '');
      const file = path.join(this.cfg.path, stem + '_' + timestamp.slice(0, 10) + '.log');
      const sorted = data ? Object.fromEntries(Object.keys(data).sort().map((key) => [key, data[key]])) : null;
      const line = '[' + timestamp + '][' + level + '] ' + message + (sorted && Object.keys(sorted).length ? ' ' + JSON.stringify(sorted) : '') + '\n';
      fs.appendFileSync(file, line, 'utf8');
    } catch { /* 日志故障不影响业务。 */ }
  }

  public async flush(): Promise<void> { /* 同步追加，无待刷新的缓存。 */ }
  public close(): void { /* 没有常驻文件句柄。 */ }
}
