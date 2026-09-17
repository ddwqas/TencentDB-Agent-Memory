import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from '../../src/panel/infra/console-logger.js';

afterEach(() => vi.restoreAllMocks());

describe('Panel 日志格式', () => {
  it('采用无颜色的服务日志头，并保留请求标识和复杂 JSON 字段', () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = new ConsoleLogger({ level: 'info', format: 'pretty' }).child({ reqId: 'request-1' });
    const fields = { path: '/wiki/get', name: '文档 A B', detail: { count: 2, enabled: true } };
    logger.info('request', fields);
    const line = String(output.mock.calls[0][0]);
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[INFO \] \[panel\] request /);
    expect(line).not.toContain('\x1b');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.slice(line.indexOf('{')))).toEqual({ reqId: 'request-1', ...fields });
  });

  it('保留级别过滤，并将警告和错误写入 stderr', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = new ConsoleLogger({ level: 'warn', format: 'pretty' });
    logger.debug('ignored'); logger.info('ignored'); logger.warn('warning'); logger.error('failure');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(String(stderr.mock.calls[0][0])).toContain('[WARN ] [panel] warning');
    expect(String(stderr.mock.calls[1][0])).toContain('[ERROR] [panel] failure');
  });

  it('继续支持纯 JSON 采集格式', () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = new ConsoleLogger({ level: 'info', format: 'json', bindings: { service: 'panel' } });
    logger.info('started', { port: 8125 });
    expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({ level: 'info', msg: 'started', service: 'panel', port: 8125 });
  });
});
