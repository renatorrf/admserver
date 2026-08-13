import { describe, expect, it } from 'vitest';

import { validateDevelopmentSeedEnvironment } from '../src/db/seed-safety';

const validEnvironment = {
  nodeEnv: 'development',
  databaseUrl: 'postgres://user:password@localhost:5432/admtaxi',
  confirmation: 'CRIAR_DADOS_DEMO',
  password: 'senha-demo-segura',
};

describe('development seed safety', () => {
  it('allows an explicitly confirmed local development database', () => {
    expect(validateDevelopmentSeedEnvironment(validEnvironment).hostname).toBe('localhost');
  });

  it('blocks a remote database before connecting', () => {
    expect(() => validateDevelopmentSeedEnvironment({
      ...validEnvironment, databaseUrl: 'postgres://user:password@database.example.com:5432/admtaxi',
    })).toThrow('somente bancos locais');
  });

  it('requires the exact confirmation and a strong demo password', () => {
    expect(() => validateDevelopmentSeedEnvironment({ ...validEnvironment, confirmation: 'sim' }))
      .toThrow('SEED_DEMO_CONFIRM');
    expect(() => validateDevelopmentSeedEnvironment({ ...validEnvironment, password: 'curta' }))
      .toThrow('SEED_DEMO_PASSWORD');
  });
});
