import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DailyLogWriter, localDate } from './daily-log.mjs';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /daily-log-test-/);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('同日重启追加，跨日自动切换文件，返回原日期仍追加', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-log-test-'));
  directories.push(directory);
  let date = new Date(2026, 8, 17, 23, 59);
  let writer = new DailyLogWriter(directory, 'knowledge.stdout', () => date);
  writer.write('before restart\n');
  writer.close();
  writer = new DailyLogWriter(directory, 'knowledge.stdout', () => date);
  writer.write('after restart\n');
  date = new Date(2026, 8, 18, 0, 1);
  writer.write('next day\n');
  date = new Date(2026, 8, 17, 23, 59);
  writer.write('clock corrected\n');
  writer.close();
  assert.equal(readFileSync(join(directory, 'knowledge.stdout_2026-09-17.log'), 'utf8'), 'before restart\nafter restart\nclock corrected\n');
  assert.equal(readFileSync(join(directory, 'knowledge.stdout_2026-09-18.log'), 'utf8'), 'next day\n');
});

test('Node 预加载记录 stdout 与 stderr，两次进程启动均保留日志', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-log-test-'));
  directories.push(directory);
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, ['--import', new URL('./daily-log.mjs', import.meta.url).href,
      '-e', 'console.log("out"); console.error("err");'], {
      env: { ...process.env, TDAI_LOG_DIR: directory, TDAI_LOG_NAME: 'test' }, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  assert.equal(readFileSync(join(directory, `test.stdout_${localDate()}.log`), 'utf8'), 'out\nout\n');
  assert.equal(readFileSync(join(directory, `test.stderr_${localDate()}.log`), 'utf8'), 'err\nerr\n');
});

test('启动异常写入当日日志并保留非零退出状态', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-log-test-'));
  directories.push(directory);
  const result = spawnSync(process.execPath, ['--import', new URL('./daily-log.mjs', import.meta.url).href,
    '-e', 'throw new Error("startup test failure");'], {
    env: { ...process.env, TDAI_LOG_DIR: directory, TDAI_LOG_NAME: 'failed-service' }, encoding: 'utf8', windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(readFileSync(join(directory, `failed-service.stderr_${localDate()}.log`), 'utf8'), /startup test failure/);
});
