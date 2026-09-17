import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FileLogger as CoreLogger } from '../../MemoryCore/src/core/report/file-logger.ts';
import { FileLogger as ProxyLogger } from '../../MemoryProxy/src/report/file-logger.ts';

test('Core 与 Proxy 文件日志跨日轮转，同日重新创建追加且不按旧大小配置截断', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'file-logger-test-'));
  const start = new Date(2026, 8, 17, 23, 59).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  let proxy;
  try {
    const cfg = { path: root, filename: 'core.log', rotateSizeBytes: 1, rotateBackupLimit: 1 };
    new CoreLogger(cfg).write('info', 'first');
    new CoreLogger(cfg).write('info', 'same day restart');
    proxy = new ProxyLogger({ dir: root, filename: 'proxy.log', rotateSizeBytes: 1, flushIntervalMs: 60_000 });
    proxy.write('info', 'old day buffered');
    t.mock.timers.setTime(start + 120_000);
    proxy.write('info', 'new day');
    await proxy.shutdown();
    proxy = new ProxyLogger({ dir: root, filename: 'proxy.log' });
    proxy.write('info', 'new day restart');
    await proxy.shutdown();
    new CoreLogger(cfg).write('info', 'next day');
    assert.match(readFileSync(join(root, 'core_2026-09-17.log'), 'utf8'), /first[\s\S]*same day restart/);
    assert.match(readFileSync(join(root, 'core_2026-09-18.log'), 'utf8'), /next day/);
    assert.match(readFileSync(join(root, 'proxy_2026-09-17.log'), 'utf8'), /old day buffered/);
    assert.match(readFileSync(join(root, 'proxy_2026-09-18.log'), 'utf8'), /new day[\s\S]*new day restart/);
    assert.equal(readdirSync(root).length, 4);
  } finally {
    await proxy?.shutdown();
    t.mock.timers.reset();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(root, /file-logger-test-/);
    rmSync(root, { recursive: true, force: true });
  }
});
