ALTER TABLE admtaxi.corridas
  ADD COLUMN itinerario_versao INTEGER NOT NULL DEFAULT 0 CHECK (itinerario_versao >= 0),
  ADD COLUMN solicitacao_chave UUID,
  ADD COLUMN solicitacao_hash TEXT;
CREATE UNIQUE INDEX corridas_solicitacao_chave_idx
  ON admtaxi.corridas (empresa_id, solicitante_usuario_id, solicitacao_chave)
  WHERE solicitacao_chave IS NOT NULL;

ALTER TABLE admtaxi.corrida_paradas DROP CONSTRAINT corrida_paradas_ordem_valida;
ALTER TABLE admtaxi.corrida_paradas
  ADD CONSTRAINT corrida_paradas_ordem_valida CHECK (ordem BETWEEN 1 AND 32),
  ADD CONSTRAINT corrida_paradas_viagem_id_unico UNIQUE (empresa_id, corrida_id, id),
  ADD COLUMN estado TEXT NOT NULL DEFAULT 'PENDENTE'
    CHECK (estado IN ('PENDENTE', 'EM_DESLOCAMENTO', 'CHEGADA', 'CONCLUIDA')),
  ADD COLUMN chegada_em TIMESTAMPTZ,
  ADD COLUMN saida_em TIMESTAMPTZ;

CREATE TABLE admtaxi.corrida_participacoes (
  empresa_id UUID NOT NULL,
  corrida_id UUID NOT NULL,
  funcionario_id UUID NOT NULL,
  embarque_id UUID NOT NULL,
  desembarque_id UUID NOT NULL,
  estado TEXT NOT NULL DEFAULT 'AGUARDANDO'
    CHECK (estado IN ('AGUARDANDO', 'EMBARCADO', 'DESEMBARCADO', 'AUSENTE', 'CANCELADO')),
  motivo TEXT,
  embarque_em TIMESTAMPTZ,
  desembarque_em TIMESTAMPTZ,
  PRIMARY KEY (empresa_id, corrida_id, funcionario_id),
  FOREIGN KEY (empresa_id, corrida_id) REFERENCES admtaxi.corridas (empresa_id, id),
  FOREIGN KEY (empresa_id, funcionario_id) REFERENCES admtaxi.funcionarios (empresa_id, id),
  FOREIGN KEY (empresa_id, corrida_id, embarque_id) REFERENCES admtaxi.corrida_paradas (empresa_id, corrida_id, id),
  FOREIGN KEY (empresa_id, corrida_id, desembarque_id) REFERENCES admtaxi.corrida_paradas (empresa_id, corrida_id, id),
  CHECK (embarque_id <> desembarque_id),
  CHECK (estado NOT IN ('AUSENTE', 'CANCELADO') OR (motivo IS NOT NULL AND char_length(btrim(motivo)) >= 5))
);
CREATE INDEX corrida_participacoes_funcionario_idx
  ON admtaxi.corrida_participacoes (empresa_id, funcionario_id, corrida_id);

CREATE TABLE admtaxi.corrida_comandos (
  empresa_id UUID NOT NULL,
  corrida_id UUID NOT NULL,
  chave UUID NOT NULL,
  comando_hash TEXT NOT NULL,
  versao INTEGER NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (empresa_id, corrida_id, chave),
  FOREIGN KEY (empresa_id, corrida_id) REFERENCES admtaxi.corridas (empresa_id, id)
);
