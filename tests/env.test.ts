import { afterEach, describe, expect, it } from 'vitest';

import { getConfig, resetConfigForTests, resolveTrustProxy } from '../src/config/env';

const pushKeys = [
  'PUSH_VAPID_SUBJECT', 'PUSH_VAPID_PUBLIC_KEY', 'PUSH_VAPID_PRIVATE_KEY', 'PUSH_APP_URL',
  'PUSH_NOTIFICATION_ICON_URL', 'PUSH_NOTIFICATION_BADGE_URL', 'PUSH_DEFAULT_OPEN_URL', 'PUSH_RIDE_OPEN_URL',
] as const;
const originalPush = Object.fromEntries(pushKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of pushKeys) {
    const value = originalPush[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigForTests();
});

describe('configuracao de proxy', () => {
  it('confia em um proxy no ambiente de producao', () => {
    expect(resolveTrustProxy('production', false)).toBe(1);
  });

  it('nao confia em proxy local sem configuracao explicita', () => {
    expect(resolveTrustProxy('development', false)).toBe(false);
    expect(resolveTrustProxy('development', true)).toBe(1);
  });
});

describe('configuracao Web Push VAPID', () => {
  it('inicia com push desativado quando os valores estao ausentes ou vazios', () => {
    for (const key of pushKeys) process.env[key] = '';
    resetConfigForTests();

    expect(getConfig().push).toBeUndefined();
  });

  it('rejeita configuracao VAPID parcial', () => {
    for (const key of pushKeys) delete process.env[key];
    process.env.PUSH_VAPID_SUBJECT = 'mailto:push@example.com';
    resetConfigForTests();

    expect(() => getConfig()).toThrow(/informe todas as variaveis PUSH_VAPID/);
  });
});
