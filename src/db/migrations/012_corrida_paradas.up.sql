CREATE TYPE admtaxi.tipo_parada_corrida AS ENUM ('FUNCIONARIO', 'MANUAL');

CREATE TABLE admtaxi.corrida_paradas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  corrida_id UUID NOT NULL,
  ordem SMALLINT NOT NULL,
  tipo admtaxi.tipo_parada_corrida NOT NULL,
  funcionario_id UUID,
  descricao TEXT NOT NULL,
  latitude NUMERIC(9, 6) NOT NULL,
  longitude NUMERIC(9, 6) NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT corrida_paradas_empresa_id_unico UNIQUE (empresa_id, id),
  CONSTRAINT corrida_paradas_corrida_ordem_unica UNIQUE (empresa_id, corrida_id, ordem),
  CONSTRAINT corrida_paradas_corrida_fk
    FOREIGN KEY (empresa_id, corrida_id)
    REFERENCES admtaxi.corridas (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corrida_paradas_funcionario_fk
    FOREIGN KEY (empresa_id, funcionario_id)
    REFERENCES admtaxi.funcionarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT corrida_paradas_ordem_valida CHECK (ordem BETWEEN 1 AND 10),
  CONSTRAINT corrida_paradas_tipo_valido CHECK (
    (tipo = 'FUNCIONARIO' AND funcionario_id IS NOT NULL)
    OR (tipo = 'MANUAL' AND funcionario_id IS NULL)
  ),
  CONSTRAINT corrida_paradas_descricao_valida CHECK (char_length(btrim(descricao)) BETWEEN 3 AND 1000),
  CONSTRAINT corrida_paradas_latitude_valida CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT corrida_paradas_longitude_valida CHECK (longitude BETWEEN -180 AND 180)
);

CREATE UNIQUE INDEX corrida_paradas_funcionario_unico_idx
  ON admtaxi.corrida_paradas (empresa_id, corrida_id, funcionario_id)
  WHERE funcionario_id IS NOT NULL;

CREATE INDEX corrida_paradas_corrida_idx
  ON admtaxi.corrida_paradas (empresa_id, corrida_id, ordem);
