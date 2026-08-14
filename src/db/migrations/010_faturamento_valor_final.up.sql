CREATE TYPE admtaxi.status_faturamento AS ENUM ('ABERTO', 'FECHADO', 'CANCELADO');

CREATE TABLE admtaxi.faturamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  numero BIGINT NOT NULL,
  periodo_inicio DATE NOT NULL,
  periodo_fim DATE NOT NULL,
  prestador_id UUID,
  status admtaxi.status_faturamento NOT NULL DEFAULT 'ABERTO',
  quantidade_corridas INTEGER NOT NULL DEFAULT 0,
  valor_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  observacao TEXT,
  criado_por_usuario_id UUID NOT NULL,
  fechado_em TIMESTAMPTZ,
  cancelado_em TIMESTAMPTZ,
  motivo_cancelamento TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT faturamentos_empresa_id_unico UNIQUE (empresa_id, id),
  CONSTRAINT faturamentos_empresa_numero_unico UNIQUE (empresa_id, numero),
  CONSTRAINT faturamentos_periodo_valido CHECK (periodo_inicio <= periodo_fim),
  CONSTRAINT faturamentos_quantidade_valida CHECK (quantidade_corridas >= 0),
  CONSTRAINT faturamentos_valor_valido CHECK (valor_total >= 0),
  CONSTRAINT faturamentos_prestador_fk
    FOREIGN KEY (empresa_id, prestador_id)
    REFERENCES admtaxi.prestadores (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT faturamentos_usuario_fk
    FOREIGN KEY (empresa_id, criado_por_usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT faturamentos_fechamento_valido CHECK (
    (status = 'ABERTO' AND fechado_em IS NULL AND cancelado_em IS NULL)
    OR (status = 'FECHADO' AND fechado_em IS NOT NULL AND cancelado_em IS NULL)
    OR (status = 'CANCELADO' AND cancelado_em IS NOT NULL AND motivo_cancelamento IS NOT NULL)
  )
);

CREATE INDEX faturamentos_empresa_status_idx
  ON admtaxi.faturamentos (empresa_id, status, periodo_inicio DESC, periodo_fim DESC);
CREATE INDEX faturamentos_prestador_idx
  ON admtaxi.faturamentos (empresa_id, prestador_id, criado_em DESC);

CREATE TABLE admtaxi.faturamento_itens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  faturamento_id UUID NOT NULL,
  corrida_id UUID NOT NULL,
  prestador_id UUID NOT NULL,
  valor_faturado NUMERIC(12, 2) NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT faturamento_itens_empresa_id_unico UNIQUE (empresa_id, id),
  CONSTRAINT faturamento_itens_valor_valido CHECK (valor_faturado >= 0),
  CONSTRAINT faturamento_itens_faturamento_fk
    FOREIGN KEY (empresa_id, faturamento_id)
    REFERENCES admtaxi.faturamentos (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT faturamento_itens_corrida_fk
    FOREIGN KEY (empresa_id, corrida_id)
    REFERENCES admtaxi.corridas (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT faturamento_itens_prestador_fk
    FOREIGN KEY (empresa_id, prestador_id)
    REFERENCES admtaxi.prestadores (empresa_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX faturamento_itens_corrida_ativa_unica
  ON admtaxi.faturamento_itens (empresa_id, corrida_id) WHERE ativo = TRUE;
CREATE INDEX faturamento_itens_faturamento_idx
  ON admtaxi.faturamento_itens (empresa_id, faturamento_id, criado_em);

CREATE TABLE admtaxi.faturamento_exclusoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  faturamento_id UUID NOT NULL,
  corrida_id UUID NOT NULL,
  motivo TEXT NOT NULL,
  usuario_id UUID NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT faturamento_exclusoes_motivo_valido CHECK (length(trim(motivo)) >= 5),
  CONSTRAINT faturamento_exclusoes_item_unico UNIQUE (faturamento_id, corrida_id),
  CONSTRAINT faturamento_exclusoes_faturamento_fk
    FOREIGN KEY (empresa_id, faturamento_id)
    REFERENCES admtaxi.faturamentos (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT faturamento_exclusoes_corrida_fk
    FOREIGN KEY (empresa_id, corrida_id)
    REFERENCES admtaxi.corridas (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT faturamento_exclusoes_usuario_fk
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT
);

CREATE TABLE admtaxi.corrida_valor_ajustes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  corrida_id UUID NOT NULL,
  valor_anterior NUMERIC(12, 2) NOT NULL,
  valor_novo NUMERIC(12, 2) NOT NULL,
  justificativa TEXT NOT NULL,
  usuario_id UUID NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT corrida_valor_ajustes_valores_validos CHECK (valor_anterior >= 0 AND valor_novo >= 0),
  CONSTRAINT corrida_valor_ajustes_justificativa_valida CHECK (length(trim(justificativa)) >= 5),
  CONSTRAINT corrida_valor_ajustes_corrida_fk
    FOREIGN KEY (empresa_id, corrida_id)
    REFERENCES admtaxi.corridas (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corrida_valor_ajustes_usuario_fk
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT
);

CREATE INDEX corrida_valor_ajustes_corrida_idx
  ON admtaxi.corrida_valor_ajustes (empresa_id, corrida_id, criado_em DESC);

CREATE TRIGGER faturamentos_definir_atualizado_em
BEFORE UPDATE ON admtaxi.faturamentos
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();
