import argon2 from 'argon2';
import dotenv from 'dotenv';
import { Pool, type PoolClient } from 'pg';

import { validateDevelopmentSeedEnvironment } from './seed-safety';

dotenv.config({ quiet: true });

type IdRow = { id: string };

async function upsertUser(
  client: PoolClient,
  empresaId: string,
  passwordHash: string,
  profile: 'GESTOR' | 'GERENTE' | 'PRESTADOR',
  name: string,
  email: string,
): Promise<string> {
  const result = await client.query<IdRow>(`
    INSERT INTO admtaxi.usuarios (empresa_id, nome, email, telefone, senha_hash, perfil, ativo)
    VALUES ($1, $2, $3, '(11) 90000-0000', $4, $5::admtaxi.perfil_usuario, TRUE)
    ON CONFLICT (empresa_id, email) DO UPDATE
      SET nome = EXCLUDED.nome, senha_hash = EXCLUDED.senha_hash, perfil = EXCLUDED.perfil, ativo = TRUE
    RETURNING id
  `, [empresaId, name, email, passwordHash, profile]);
  return result.rows[0]!.id;
}

async function seed(client: PoolClient, password: string): Promise<void> {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const company = await client.query<IdRow>(`
    INSERT INTO admtaxi.empresas
      (codigo_acesso, razao_social, nome_fantasia, telefone, email, ativo)
    VALUES ('ADM-DEMO', 'ADM Taxi Demonstracao Ltda', 'ADM Taxi Demo', '(11) 3000-0000', 'contato@demo.local', TRUE)
    ON CONFLICT (codigo_acesso) DO UPDATE SET
      razao_social = EXCLUDED.razao_social, nome_fantasia = EXCLUDED.nome_fantasia,
      telefone = EXCLUDED.telefone, email = EXCLUDED.email, ativo = TRUE
    RETURNING id
  `);
  const empresaId = company.rows[0]!.id;
  const gestorId = await upsertUser(client, empresaId, passwordHash, 'GESTOR', 'Gestor Demo', 'gestor@demo.local');
  const gerenteId = await upsertUser(client, empresaId, passwordHash, 'GERENTE', 'Gerente Demo', 'gerente@demo.local');
  const prestadorUsuarioId = await upsertUser(
    client, empresaId, passwordHash, 'PRESTADOR', 'Motorista Demo', 'motorista@demo.local',
  );

  const center = await client.query<IdRow>(`
    INSERT INTO admtaxi.centros_custo (empresa_id, codigo, nome, descricao, ativo)
    VALUES ($1, 'ADM', 'Administracao', 'Centro de custo para demonstracao', TRUE)
    ON CONFLICT (empresa_id, codigo) DO UPDATE SET nome = EXCLUDED.nome, descricao = EXCLUDED.descricao, ativo = TRUE
    RETURNING id
  `, [empresaId]);
  const centroCustoId = center.rows[0]!.id;
  await client.query(`
    INSERT INTO admtaxi.gerente_centros_custo (empresa_id, gerente_usuario_id, centro_custo_id)
    VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
  `, [empresaId, gerenteId, centroCustoId]);

  const employee = await client.query<IdRow>(`
    INSERT INTO admtaxi.funcionarios
      (empresa_id, centro_custo_id, nome, matricula, telefone, email, endereco_padrao,
       latitude_padrao, longitude_padrao, ativo)
    VALUES ($1, $2, 'Passageiro Demo', 'DEMO-001', '(11) 91111-1111', 'passageiro@demo.local',
      'Avenida Paulista, 1000 - Sao Paulo', -23.564224, -46.652484, TRUE)
    ON CONFLICT (empresa_id, matricula) DO UPDATE SET
      centro_custo_id = EXCLUDED.centro_custo_id, nome = EXCLUDED.nome, telefone = EXCLUDED.telefone,
      email = EXCLUDED.email, endereco_padrao = EXCLUDED.endereco_padrao,
      latitude_padrao = EXCLUDED.latitude_padrao, longitude_padrao = EXCLUDED.longitude_padrao, ativo = TRUE
    RETURNING id
  `, [empresaId, centroCustoId]);
  const funcionarioId = employee.rows[0]!.id;

  const provider = await client.query<IdRow>(`
    INSERT INTO admtaxi.prestadores
      (empresa_id, usuario_id, nome, cpf, telefone, email, numero_cnh, validade_cnh, disponivel, ativo)
    VALUES ($1, $2, 'Motorista Demo', '12345678901', '(11) 92222-2222', 'motorista@demo.local',
      'DEMO123456', CURRENT_DATE + INTERVAL '2 years', TRUE, TRUE)
    ON CONFLICT (empresa_id, cpf) DO UPDATE SET
      usuario_id = EXCLUDED.usuario_id, nome = EXCLUDED.nome, telefone = EXCLUDED.telefone,
      email = EXCLUDED.email, numero_cnh = EXCLUDED.numero_cnh, validade_cnh = EXCLUDED.validade_cnh,
      disponivel = TRUE, ativo = TRUE
    RETURNING id
  `, [empresaId, prestadorUsuarioId]);
  const prestadorId = provider.rows[0]!.id;
  const vehicle = await client.query<IdRow>(`
    INSERT INTO admtaxi.veiculos
      (empresa_id, prestador_id, placa, marca, modelo, cor, ano, capacidade_passageiros, ativo)
    VALUES ($1, $2, 'DEM0A01', 'Toyota', 'Corolla', 'Prata', 2024, 4, TRUE)
    ON CONFLICT (empresa_id, placa) DO UPDATE SET
      prestador_id = EXCLUDED.prestador_id, marca = EXCLUDED.marca, modelo = EXCLUDED.modelo,
      cor = EXCLUDED.cor, ano = EXCLUDED.ano, capacidade_passageiros = EXCLUDED.capacidade_passageiros, ativo = TRUE
    RETURNING id
  `, [empresaId, prestadorId]);
  const veiculoId = vehicle.rows[0]!.id;

  const commonValues = [empresaId, gestorId, funcionarioId, centroCustoId, prestadorId, veiculoId];
  await client.query(`
    INSERT INTO admtaxi.corridas
      (empresa_id, solicitante_usuario_id, funcionario_id, centro_custo_id, prestador_id, veiculo_id,
       status, tipo, quantidade_passageiros, origem_descricao, destino_descricao,
       observacao_solicitante, valor_estimado, valor_final, solicitada_em, finalizada_em)
    SELECT $1, $2, $3, $4, $5, $6, 'FINALIZADA', 'IMEDIATA', 1,
      'Avenida Paulista, 1000 - Sao Paulo', 'Aeroporto de Congonhas - Sao Paulo',
      '[SEED-DEMO] Corrida finalizada', 72.50, 70.00, CURRENT_TIMESTAMP - INTERVAL '7 days',
      CURRENT_TIMESTAMP - INTERVAL '7 days' + INTERVAL '45 minutes'
    WHERE NOT EXISTS (
      SELECT 1 FROM admtaxi.corridas WHERE empresa_id = $1 AND observacao_solicitante = '[SEED-DEMO] Corrida finalizada'
    )
  `, commonValues);
  const activeRide = await client.query<IdRow>(`
    INSERT INTO admtaxi.corridas
      (empresa_id, solicitante_usuario_id, funcionario_id, centro_custo_id, prestador_id, veiculo_id,
       status, tipo, quantidade_passageiros, origem_descricao, destino_descricao,
       observacao_solicitante, valor_estimado, aceita_em, embarque_em)
    SELECT $1, $2, $3, $4, $5, $6, 'EM_CORRIDA', 'IMEDIATA', 1,
      'Avenida Paulista, 1000 - Sao Paulo', 'Praca da Se - Sao Paulo',
      '[SEED-DEMO] Corrida ativa', 38.00, CURRENT_TIMESTAMP - INTERVAL '20 minutes', CURRENT_TIMESTAMP - INTERVAL '5 minutes'
    WHERE NOT EXISTS (
      SELECT 1 FROM admtaxi.corridas WHERE empresa_id = $1 AND observacao_solicitante = '[SEED-DEMO] Corrida ativa'
    ) RETURNING id
  `, commonValues);
  await client.query(`
    INSERT INTO admtaxi.corridas
      (empresa_id, solicitante_usuario_id, funcionario_id, centro_custo_id, status, tipo, agendada_para,
       quantidade_passageiros, origem_descricao, destino_descricao, observacao_solicitante, valor_estimado)
    SELECT $1, $2, $3, $4, 'SOLICITADA', 'AGENDADA', CURRENT_TIMESTAMP + INTERVAL '1 day', 2,
      'Avenida Paulista, 1000 - Sao Paulo', 'Terminal Rodoviario Tiete - Sao Paulo',
      '[SEED-DEMO] Corrida agendada', 55.00
    WHERE NOT EXISTS (
      SELECT 1 FROM admtaxi.corridas WHERE empresa_id = $1 AND observacao_solicitante = '[SEED-DEMO] Corrida agendada'
    )
  `, commonValues.slice(0, 4));
  if (activeRide.rows[0]) {
    await client.query(`
      INSERT INTO admtaxi.corrida_localizacoes
        (empresa_id, corrida_id, prestador_id, latitude, longitude, precisao_metros)
      VALUES ($1, $2, $3, -23.550520, -46.633308, 12)
    `, [empresaId, activeRide.rows[0].id, prestadorId]);
  }
}

async function main(): Promise<void> {
  const databaseUrl = validateDevelopmentSeedEnvironment({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    confirmation: process.env.SEED_DEMO_CONFIRM,
    password: process.env.SEED_DEMO_PASSWORD,
  });
  const pool = new Pool({ connectionString: databaseUrl.toString(), application_name: 'adm-taxi-development-seed', max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seed(client, process.env.SEED_DEMO_PASSWORD!);
    await client.query('COMMIT');
    console.log('Dados de demonstracao criados ou atualizados no banco local.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Erro desconhecido';
  console.error(`Falha no seed de desenvolvimento: ${message}`);
  process.exitCode = 1;
});
