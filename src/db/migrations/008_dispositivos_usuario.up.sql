CREATE TABLE admtaxi.dispositivos_usuario (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL,
  usuario_id UUID NOT NULL,
  chave_dispositivo UUID NOT NULL,
  plataforma VARCHAR(16) NOT NULL,
  nome_dispositivo VARCHAR(120) NOT NULL,
  navegador VARCHAR(80),
  modo_acesso VARCHAR(16) NOT NULL DEFAULT 'NAVEGADOR',
  notificacoes_status VARCHAR(24) NOT NULL DEFAULT 'NAO_SOLICITADA',
  geolocalizacao_status VARCHAR(24) NOT NULL DEFAULT 'NAO_SOLICITADA',
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_uso_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT dispositivos_usuario_usuario_fk
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT dispositivos_usuario_chave_unica UNIQUE (empresa_id, usuario_id, chave_dispositivo),
  CONSTRAINT dispositivos_usuario_plataforma_valida CHECK (plataforma IN ('WEB', 'ANDROID', 'IOS')),
  CONSTRAINT dispositivos_usuario_modo_valido CHECK (modo_acesso IN ('NAVEGADOR', 'PWA')),
  CONSTRAINT dispositivos_usuario_notificacoes_status_valido CHECK (
    notificacoes_status IN ('ATIVA', 'INATIVA', 'BLOQUEADA', 'NAO_SOLICITADA', 'NAO_SUPORTADA')
  ),
  CONSTRAINT dispositivos_usuario_geolocalizacao_status_valido CHECK (
    geolocalizacao_status IN ('ATIVA', 'BLOQUEADA', 'NAO_SOLICITADA', 'NAO_SUPORTADA')
  )
);

CREATE INDEX dispositivos_usuario_empresa_ativo_idx
  ON admtaxi.dispositivos_usuario (empresa_id, ativo, ultimo_uso_em DESC);
CREATE INDEX dispositivos_usuario_usuario_idx
  ON admtaxi.dispositivos_usuario (empresa_id, usuario_id, ultimo_uso_em DESC);

CREATE TRIGGER dispositivos_usuario_definir_atualizado_em
BEFORE UPDATE ON admtaxi.dispositivos_usuario
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();
