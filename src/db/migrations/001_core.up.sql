CREATE TYPE admtaxi.perfil_usuario AS ENUM ('PRESTADOR', 'GERENTE', 'GESTOR');

CREATE TABLE admtaxi.empresas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_acesso CITEXT NOT NULL UNIQUE,
  razao_social VARCHAR(200) NOT NULL,
  nome_fantasia VARCHAR(150) NOT NULL,
  cnpj VARCHAR(14) UNIQUE,
  telefone VARCHAR(20),
  email CITEXT,
  timezone VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT empresas_codigo_acesso_formato CHECK (codigo_acesso::text ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$'),
  CONSTRAINT empresas_cnpj_formato CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$')
);

CREATE TABLE admtaxi.usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  nome VARCHAR(150) NOT NULL,
  email CITEXT NOT NULL,
  telefone VARCHAR(20),
  senha_hash TEXT NOT NULL,
  perfil admtaxi.perfil_usuario NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_acesso_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT usuarios_empresa_email_unico UNIQUE (empresa_id, email),
  CONSTRAINT usuarios_empresa_id_unico UNIQUE (empresa_id, id)
);

CREATE INDEX usuarios_empresa_idx ON admtaxi.usuarios (empresa_id);
CREATE INDEX usuarios_empresa_perfil_ativo_idx ON admtaxi.usuarios (empresa_id, perfil, ativo);
CREATE INDEX usuarios_email_idx ON admtaxi.usuarios (email);

CREATE TABLE admtaxi.refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL,
  usuario_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expira_em TIMESTAMPTZ NOT NULL,
  revogado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT refresh_tokens_usuario_fk
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT refresh_tokens_expiracao_valida CHECK (expira_em > criado_em)
);

CREATE INDEX refresh_tokens_usuario_idx ON admtaxi.refresh_tokens (empresa_id, usuario_id);
CREATE INDEX refresh_tokens_validade_idx ON admtaxi.refresh_tokens (expira_em) WHERE revogado_em IS NULL;
