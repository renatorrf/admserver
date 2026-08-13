CREATE TYPE admtaxi.status_corrida AS ENUM (
  'SOLICITADA',
  'OFERTADA',
  'ACEITA',
  'EM_DESLOCAMENTO',
  'AGUARDANDO_PASSAGEIRO',
  'EM_CORRIDA',
  'FINALIZADA',
  'CANCELADA',
  'RECUSADA'
);

CREATE TYPE admtaxi.tipo_corrida AS ENUM ('IMEDIATA', 'AGENDADA');

CREATE TABLE admtaxi.corridas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  solicitante_usuario_id UUID NOT NULL,
  funcionario_id UUID NOT NULL,
  centro_custo_id UUID NOT NULL,
  prestador_id UUID,
  veiculo_id UUID,
  status admtaxi.status_corrida NOT NULL DEFAULT 'SOLICITADA',
  tipo admtaxi.tipo_corrida NOT NULL,
  agendada_para TIMESTAMPTZ,
  quantidade_passageiros SMALLINT NOT NULL DEFAULT 1,
  origem_descricao TEXT NOT NULL,
  origem_latitude NUMERIC(9, 6),
  origem_longitude NUMERIC(9, 6),
  destino_descricao TEXT NOT NULL,
  destino_latitude NUMERIC(9, 6),
  destino_longitude NUMERIC(9, 6),
  observacao_solicitante TEXT,
  observacao_prestador TEXT,
  valor_estimado NUMERIC(12, 2),
  valor_final NUMERIC(12, 2),
  solicitada_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  aceita_em TIMESTAMPTZ,
  deslocamento_iniciado_em TIMESTAMPTZ,
  chegada_embarque_em TIMESTAMPTZ,
  embarque_em TIMESTAMPTZ,
  desembarque_em TIMESTAMPTZ,
  cancelada_em TIMESTAMPTZ,
  finalizada_em TIMESTAMPTZ,
  motivo_cancelamento TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT corridas_empresa_id_unico UNIQUE (empresa_id, id),
  CONSTRAINT corridas_solicitante_fk
    FOREIGN KEY (empresa_id, solicitante_usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corridas_funcionario_fk
    FOREIGN KEY (empresa_id, funcionario_id)
    REFERENCES admtaxi.funcionarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corridas_centro_custo_fk
    FOREIGN KEY (empresa_id, centro_custo_id)
    REFERENCES admtaxi.centros_custo (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corridas_prestador_fk
    FOREIGN KEY (empresa_id, prestador_id)
    REFERENCES admtaxi.prestadores (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corridas_veiculo_fk
    FOREIGN KEY (empresa_id, veiculo_id)
    REFERENCES admtaxi.veiculos (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corridas_quantidade_passageiros_valida CHECK (quantidade_passageiros BETWEEN 1 AND 99),
  CONSTRAINT corridas_agendamento_valido CHECK (
    (tipo = 'IMEDIATA' AND agendada_para IS NULL)
    OR (tipo = 'AGENDADA' AND agendada_para IS NOT NULL)
  ),
  CONSTRAINT corridas_origem_latitude_valida CHECK (origem_latitude IS NULL OR origem_latitude BETWEEN -90 AND 90),
  CONSTRAINT corridas_origem_longitude_valida CHECK (origem_longitude IS NULL OR origem_longitude BETWEEN -180 AND 180),
  CONSTRAINT corridas_origem_coordenadas_completas CHECK ((origem_latitude IS NULL) = (origem_longitude IS NULL)),
  CONSTRAINT corridas_destino_latitude_valida CHECK (destino_latitude IS NULL OR destino_latitude BETWEEN -90 AND 90),
  CONSTRAINT corridas_destino_longitude_valida CHECK (destino_longitude IS NULL OR destino_longitude BETWEEN -180 AND 180),
  CONSTRAINT corridas_destino_coordenadas_completas CHECK ((destino_latitude IS NULL) = (destino_longitude IS NULL)),
  CONSTRAINT corridas_valor_estimado_valido CHECK (valor_estimado IS NULL OR valor_estimado >= 0),
  CONSTRAINT corridas_valor_final_valido CHECK (valor_final IS NULL OR valor_final >= 0),
  CONSTRAINT corridas_cancelamento_valido CHECK (
    (status <> 'CANCELADA') OR (cancelada_em IS NOT NULL AND motivo_cancelamento IS NOT NULL)
  ),
  CONSTRAINT corridas_finalizacao_valida CHECK (
    (status <> 'FINALIZADA') OR (finalizada_em IS NOT NULL AND valor_final IS NOT NULL)
  )
);

CREATE INDEX corridas_empresa_status_idx ON admtaxi.corridas (empresa_id, status);
CREATE INDEX corridas_empresa_solicitada_em_idx ON admtaxi.corridas (empresa_id, solicitada_em DESC);
CREATE INDEX corridas_empresa_agendada_para_idx ON admtaxi.corridas (empresa_id, agendada_para) WHERE agendada_para IS NOT NULL;
CREATE INDEX corridas_prestador_idx ON admtaxi.corridas (empresa_id, prestador_id, status);
CREATE INDEX corridas_centro_custo_idx ON admtaxi.corridas (empresa_id, centro_custo_id, solicitada_em DESC);
CREATE INDEX corridas_funcionario_idx ON admtaxi.corridas (empresa_id, funcionario_id, solicitada_em DESC);
CREATE INDEX corridas_solicitante_idx ON admtaxi.corridas (empresa_id, solicitante_usuario_id, solicitada_em DESC);

CREATE TABLE admtaxi.corrida_localizacoes (
  id BIGSERIAL PRIMARY KEY,
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  corrida_id UUID NOT NULL,
  prestador_id UUID NOT NULL,
  latitude NUMERIC(9, 6) NOT NULL,
  longitude NUMERIC(9, 6) NOT NULL,
  precisao_metros NUMERIC(8, 2),
  velocidade NUMERIC(8, 2),
  direcao NUMERIC(6, 2),
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT corrida_localizacoes_corrida_fk
    FOREIGN KEY (empresa_id, corrida_id)
    REFERENCES admtaxi.corridas (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corrida_localizacoes_prestador_fk
    FOREIGN KEY (empresa_id, prestador_id)
    REFERENCES admtaxi.prestadores (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corrida_localizacoes_latitude_valida CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT corrida_localizacoes_longitude_valida CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT corrida_localizacoes_precisao_valida CHECK (precisao_metros IS NULL OR precisao_metros >= 0),
  CONSTRAINT corrida_localizacoes_velocidade_valida CHECK (velocidade IS NULL OR velocidade >= 0),
  CONSTRAINT corrida_localizacoes_direcao_valida CHECK (direcao IS NULL OR direcao BETWEEN 0 AND 360)
);

CREATE INDEX corrida_localizacoes_corrida_data_idx
  ON admtaxi.corrida_localizacoes (empresa_id, corrida_id, registrado_em DESC);
CREATE INDEX corrida_localizacoes_retencao_idx
  ON admtaxi.corrida_localizacoes (registrado_em);

CREATE TABLE admtaxi.corrida_eventos (
  id BIGSERIAL PRIMARY KEY,
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  corrida_id UUID NOT NULL,
  usuario_id UUID,
  tipo_evento VARCHAR(80) NOT NULL,
  status_anterior admtaxi.status_corrida,
  status_novo admtaxi.status_corrida,
  descricao TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT corrida_eventos_corrida_fk
    FOREIGN KEY (empresa_id, corrida_id)
    REFERENCES admtaxi.corridas (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corrida_eventos_usuario_fk
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corrida_eventos_metadata_objeto CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX corrida_eventos_corrida_data_idx
  ON admtaxi.corrida_eventos (empresa_id, corrida_id, criado_em DESC);
CREATE INDEX corrida_eventos_usuario_idx
  ON admtaxi.corrida_eventos (empresa_id, usuario_id, criado_em DESC);
