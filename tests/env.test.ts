import { describe, expect, it } from 'vitest';

import { resolveTrustProxy } from '../src/config/env';

describe('configuracao de proxy', () => {
  it('confia em um proxy no ambiente de producao', () => {
    expect(resolveTrustProxy('production', false)).toBe(1);
  });

  it('nao confia em proxy local sem configuracao explicita', () => {
    expect(resolveTrustProxy('development', false)).toBe(false);
    expect(resolveTrustProxy('development', true)).toBe(1);
  });
});
