const localDatabaseHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export type DevelopmentSeedEnvironment = {
  nodeEnv?: string;
  databaseUrl?: string;
  confirmation?: string;
  password?: string;
};

export function validateDevelopmentSeedEnvironment(environment: DevelopmentSeedEnvironment): URL {
  if (environment.nodeEnv !== 'development') {
    throw new Error('Seed bloqueado: NODE_ENV deve ser development.');
  }
  if (environment.confirmation !== 'CRIAR_DADOS_DEMO') {
    throw new Error('Seed bloqueado: defina SEED_DEMO_CONFIRM=CRIAR_DADOS_DEMO.');
  }
  if (!environment.password || environment.password.length < 12) {
    throw new Error('Seed bloqueado: SEED_DEMO_PASSWORD deve ter ao menos 12 caracteres.');
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(environment.databaseUrl ?? '');
  } catch {
    throw new Error('Seed bloqueado: DATABASE_URL invalida.');
  }
  if (!localDatabaseHosts.has(databaseUrl.hostname.toLowerCase())) {
    throw new Error('Seed bloqueado: somente bancos locais podem receber dados de demonstracao.');
  }
  return databaseUrl;
}
