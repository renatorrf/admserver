ALTER TABLE admtaxi.empresas
  ADD COLUMN cidade_padrao VARCHAR(120),
  ADD COLUMN estado_padrao CHAR(2),
  ADD COLUMN latitude_padrao NUMERIC(9, 6),
  ADD COLUMN longitude_padrao NUMERIC(9, 6),
  ADD CONSTRAINT empresas_estado_padrao_formato
    CHECK (estado_padrao IS NULL OR estado_padrao ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT empresas_latitude_padrao_valida
    CHECK (latitude_padrao IS NULL OR latitude_padrao BETWEEN -90 AND 90),
  ADD CONSTRAINT empresas_longitude_padrao_valida
    CHECK (longitude_padrao IS NULL OR longitude_padrao BETWEEN -180 AND 180),
  ADD CONSTRAINT empresas_coordenadas_padrao_completas
    CHECK ((latitude_padrao IS NULL) = (longitude_padrao IS NULL));

-- Dados iniciais das empresas existentes. Depois deste ponto a regiao e administrada pelo cadastro da empresa.
UPDATE admtaxi.empresas
   SET cidade_padrao = 'Uberlandia',
       estado_padrao = 'MG',
       latitude_padrao = -18.918600,
       longitude_padrao = -48.277200
 WHERE codigo_acesso = 'ADM-BR' AND cidade_padrao IS NULL;

CREATE TABLE admtaxi.dispositivos_push (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  usuario_id UUID NOT NULL,
  token TEXT NOT NULL,
  plataforma VARCHAR(16) NOT NULL,
  nome_dispositivo VARCHAR(120),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_uso_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT dispositivos_push_usuario_fk
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT dispositivos_push_token_unico UNIQUE (token),
  CONSTRAINT dispositivos_push_empresa_id_unico UNIQUE (empresa_id, id),
  CONSTRAINT dispositivos_push_plataforma_valida
    CHECK (plataforma IN ('WEB', 'ANDROID', 'IOS'))
);

CREATE INDEX dispositivos_push_usuario_ativo_idx
  ON admtaxi.dispositivos_push (empresa_id, usuario_id, ativo);

CREATE TABLE admtaxi.notificacoes_push (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  usuario_id UUID NOT NULL,
  corrida_id UUID,
  evento VARCHAR(80) NOT NULL,
  titulo VARCHAR(120) NOT NULL,
  corpo VARCHAR(240) NOT NULL,
  chave_deduplicacao VARCHAR(180) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDENTE',
  tentada_em TIMESTAMPTZ,
  resultado JSONB NOT NULL DEFAULT '{}'::jsonb,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT notificacoes_push_usuario_fk
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT notificacoes_push_corrida_fk
    FOREIGN KEY (empresa_id, corrida_id)
    REFERENCES admtaxi.corridas (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT notificacoes_push_deduplicacao_unica UNIQUE (chave_deduplicacao),
  CONSTRAINT notificacoes_push_status_valido
    CHECK (status IN ('PENDENTE', 'ENVIADA', 'PARCIAL', 'FALHA', 'IGNORADA')),
  CONSTRAINT notificacoes_push_resultado_objeto CHECK (jsonb_typeof(resultado) = 'object')
);

CREATE INDEX notificacoes_push_usuario_data_idx
  ON admtaxi.notificacoes_push (empresa_id, usuario_id, criado_em DESC);
CREATE INDEX notificacoes_push_corrida_idx
  ON admtaxi.notificacoes_push (empresa_id, corrida_id, criado_em DESC);

CREATE TRIGGER dispositivos_push_definir_atualizado_em
BEFORE UPDATE ON admtaxi.dispositivos_push
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();
