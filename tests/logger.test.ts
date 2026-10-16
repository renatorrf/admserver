import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/config/logger';

const { resolve, pino } = vi.hoisted(() => ({ resolve: vi.fn(), pino: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => ({ resolve }) }));
vi.mock('pino', () => ({ default: pino }));

const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

describe('logger startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('K_SERVICE', '');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    resolve.mockReset().mockReturnValue('/installed/pino-pretty/index.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalTTY) Object.defineProperty(process.stdout, 'isTTY', originalTTY);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  });

  it.each(['production', 'test'] as const)('uses JSON without resolving dev dependencies in %s', nodeEnv => {
    createLogger({ nodeEnv, logLevel: 'info' });
    expect(resolve).not.toHaveBeenCalled();
    expect(pino.mock.calls[0]![0]).not.toHaveProperty('transport');
  });

  it('uses JSON in Cloud Run even when NODE_ENV is development', () => {
    vi.stubEnv('K_SERVICE', 'admserver');
    createLogger({ nodeEnv: 'development', logLevel: 'info' });
    expect(resolve).not.toHaveBeenCalled();
    expect(pino.mock.calls[0]![0]).not.toHaveProperty('transport');
  });

  it('uses JSON when output is redirected or noninteractive', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    createLogger({ nodeEnv: 'development', logLevel: 'info' });
    expect(resolve).not.toHaveBeenCalled();
    expect(pino.mock.calls[0]![0]).not.toHaveProperty('transport');
  });

  it('keeps pretty output in an interactive development terminal', () => {
    createLogger({ nodeEnv: 'development', logLevel: 'debug' });
    expect(resolve).toHaveBeenCalledWith('pino-pretty');
    expect(pino.mock.calls[0]![0]).toMatchObject({ level: 'debug', transport: { target: '/installed/pino-pretty/index.js' } });
  });

  it('falls back to JSON when pino-pretty is not installed, preserving redaction', () => {
    resolve.mockImplementation(() => { throw new Error('MODULE_NOT_FOUND'); });
    expect(() => createLogger({ nodeEnv: 'development', logLevel: 'info' })).not.toThrow();
    const options = pino.mock.calls[0]![0];
    expect(options).not.toHaveProperty('transport');
    expect(options.redact.censor).toBe('[REMOVIDO]');
    expect(options.redact.paths).toEqual(expect.arrayContaining(['req.headers.authorization', 'senha', 'token', 'DATABASE_URL']));
  });
});
