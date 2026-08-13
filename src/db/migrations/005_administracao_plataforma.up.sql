CREATE TABLE admtaxi.administradores_plataforma (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario CITEXT NOT NULL UNIQUE,
  nome VARCHAR(150) NOT NULL,
  senha_hash TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  deve_alterar_senha BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_acesso_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT administradores_plataforma_usuario_formato
    CHECK (usuario::text ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,49}$')
);

CREATE INDEX administradores_plataforma_ativo_idx
  ON admtaxi.administradores_plataforma (ativo);

CREATE TABLE admtaxi.auditoria_plataforma (
  id BIGSERIAL PRIMARY KEY,
  administrador_id UUID REFERENCES admtaxi.administradores_plataforma(id) ON DELETE RESTRICT,
  entidade VARCHAR(80) NOT NULL,
  entidade_id TEXT NOT NULL,
  acao VARCHAR(50) NOT NULL,
  dados_novos JSONB,
  ip INET,
  user_agent TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT auditoria_plataforma_dados_objeto CHECK (
    dados_novos IS NULL OR jsonb_typeof(dados_novos) = 'object'
  )
);

CREATE INDEX auditoria_plataforma_data_idx
  ON admtaxi.auditoria_plataforma (criado_em DESC);

CREATE INDEX auditoria_plataforma_administrador_idx
  ON admtaxi.auditoria_plataforma (administrador_id, criado_em DESC);

CREATE TRIGGER administradores_plataforma_definir_atualizado_em
BEFORE UPDATE ON admtaxi.administradores_plataforma
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();
