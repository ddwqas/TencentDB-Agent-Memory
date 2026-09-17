/** 将服务标准输出按本地日期追加到文件；重启和跨午夜均保留已有日志。 */
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 每个输出流只保留当日文件句柄，写入前检查日期。 */
export class DailyLogWriter {
  constructor(directory, name, now = () => new Date()) {
    if (!/^[\w.-]+$/.test(name)) throw new Error('Invalid daily log name');
    this.directory = directory;
    this.name = name;
    this.now = now;
    this.day = '';
    this.fd = undefined;
    mkdirSync(directory, { recursive: true });
  }

  write(chunk, encoding = 'utf8') {
    const day = localDate(this.now());
    if (this.day !== day || this.fd === undefined) {
      this.close();
      this.fd = openSync(join(this.directory, `${this.name}_${day}.log`), 'a');
      this.day = day;
    }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset);
  }

  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}

export function installDailyLogs(directory, name) {
  const writers = [];
  for (const [kind, stream] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
    const writer = new DailyLogWriter(directory, `${name}.${kind}`);
    const original = stream.write.bind(stream);
    writers.push(writer);
    stream.write = (chunk, encoding, callback) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      try {
        writer.write(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        if (done) queueMicrotask(() => done());
        return true;
      } catch {
        // 磁盘故障时回退到原输出流，避免日志异常中断业务。
        return original(chunk, encoding, callback);
      }
    };
  }
  process.on('uncaughtExceptionMonitor', (error) => {
    try { writers[1].write(`${error.stack ?? String(error)}\n`); } catch { /* 保持原有崩溃退出行为。 */ }
  });
  process.once('exit', () => writers.forEach((writer) => writer.close()));
}

if (process.env.TDAI_LOG_DIR && process.env.TDAI_LOG_NAME) {
  installDailyLogs(process.env.TDAI_LOG_DIR, process.env.TDAI_LOG_NAME);
}
