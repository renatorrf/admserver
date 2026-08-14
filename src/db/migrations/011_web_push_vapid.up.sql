ALTER TABLE admtaxi.prestadores
  ADD COLUMN cidade_operacao VARCHAR(120),
  ADD COLUMN estado_operacao CHAR(2),
  ADD CONSTRAINT prestadores_estado_operacao_formato
    CHECK (estado_operacao IS NULL OR estado_operacao ~ '^[A-Z]{2}$');

UPDATE admtaxi.prestadores p
   SET cidade_operacao = e.cidade_padrao,
       estado_operacao = e.estado_padrao
  FROM admtaxi.empresas e
 WHERE e.id = p.empresa_id
   AND p.cidade_operacao IS NULL;

CREATE TABLE admtaxi.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  usuario_id UUID NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time BIGINT,
  user_agent TEXT,
  dispositivo_descricao VARCHAR(160),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_sucesso_em TIMESTAMPTZ,
  ultima_falha_em TIMESTAMPTZ,
  codigo_ultima_falha VARCHAR(80),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT push_subscriptions_usuario_fk
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT push_subscriptions_endpoint_unico UNIQUE (endpoint),
  CONSTRAINT push_subscriptions_empresa_id_unico UNIQUE (empresa_id, id),
  CONSTRAINT push_subscriptions_endpoint_https CHECK (endpoint ~ '^https://'),
  CONSTRAINT push_subscriptions_chaves_validas CHECK (length(p256dh) >= 20 AND length(auth) >= 8)
);

CREATE INDEX push_subscriptions_usuario_ativo_idx
  ON admtaxi.push_subscriptions (empresa_id, usuario_id, ativo, atualizado_em DESC);

ALTER TABLE admtaxi.notificacoes_push
  ADD CONSTRAINT notificacoes_push_empresa_id_unico UNIQUE (empresa_id, id);

CREATE TABLE admtaxi.push_tentativas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  notificacao_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDENTE',
  codigo_http INTEGER,
  codigo_erro VARCHAR(80),
  tentada_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT push_tentativas_notificacao_fk
    FOREIGN KEY (empresa_id, notificacao_id)
    REFERENCES admtaxi.notificacoes_push (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT push_tentativas_subscription_fk
    FOREIGN KEY (empresa_id, subscription_id)
    REFERENCES admtaxi.push_subscriptions (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT push_tentativas_dispositivo_unico UNIQUE (notificacao_id, subscription_id),
  CONSTRAINT push_tentativas_status_valido
    CHECK (status IN ('PENDENTE', 'ENVIADA', 'FALHA', 'EXPIRADA'))
);

CREATE INDEX push_tentativas_empresa_data_idx
  ON admtaxi.push_tentativas (empresa_id, criado_em DESC);

ALTER TABLE admtaxi.notificacoes_push
  ADD COLUMN url_abertura TEXT,
  ADD COLUMN tipo_payload VARCHAR(80);

CREATE TRIGGER push_subscriptions_definir_atualizado_em
BEFORE UPDATE ON admtaxi.push_subscriptions
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();
