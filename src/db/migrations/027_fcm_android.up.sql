ALTER TABLE admtaxi.dispositivos_push
  ADD COLUMN instalacao_id UUID,
  ADD COLUMN vinculo_id UUID,
  ADD COLUMN senha_versao INTEGER,
  ADD COLUMN ultimo_sucesso_em TIMESTAMPTZ,
  ADD COLUMN codigo_ultima_falha VARCHAR(100);
CREATE UNIQUE INDEX dispositivos_push_instalacao_idx ON admtaxi.dispositivos_push(instalacao_id);

CREATE TABLE admtaxi.fcm_entregas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notificacao_id UUID NOT NULL REFERENCES admtaxi.notificacoes_push(id),
  dispositivo_id UUID NOT NULL REFERENCES admtaxi.dispositivos_push(id),
  vinculo_id UUID NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDENTE'
    CHECK(status IN ('PENDENTE','ENVIADA','EXPIRADA','FALHA')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expira_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '5 minutes',
  enviada_em TIMESTAMPTZ,
  codigo_erro VARCHAR(100),
  UNIQUE(notificacao_id,dispositivo_id)
);
CREATE INDEX fcm_entregas_pendentes_idx ON admtaxi.fcm_entregas(proxima_tentativa_em) WHERE status='PENDENTE';

-- Resolve current memberships again at delivery; never grant access through a device token.
CREATE VIEW admtaxi.fcm_destinatarios AS
 SELECT d.*,r.empresa_id AS destino_empresa_id,r.id AS destino_usuario_id
 FROM admtaxi.dispositivos_push d
 JOIN admtaxi.usuarios_autenticacao owner ON owner.empresa_id=d.empresa_id AND owner.id=d.usuario_id
 JOIN admtaxi.usuarios r ON r.perfil='PRESTADOR' AND (r.id=owner.id OR
   (owner.conta_motorista_id IS NOT NULL AND r.conta_motorista_id=owner.conta_motorista_id))
 JOIN admtaxi.motorista_vinculos_ativos m ON m.usuario_id=r.id AND m.empresa_id=r.empresa_id
 WHERE d.ativo AND d.plataforma='ANDROID' AND d.vinculo_id IS NOT NULL
   AND owner.perfil='PRESTADOR' AND owner.senha_versao=d.senha_versao AND NOT owner.deve_alterar_senha;

CREATE FUNCTION admtaxi.enfileirar_fcm_android() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO admtaxi.fcm_entregas(notificacao_id,dispositivo_id,vinculo_id)
    SELECT NEW.id,d.id,d.vinculo_id FROM admtaxi.fcm_destinatarios d
    WHERE d.destino_empresa_id=NEW.empresa_id AND d.destino_usuario_id=NEW.usuario_id
    ON CONFLICT(notificacao_id,dispositivo_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER notificacoes_enfileirar_fcm AFTER INSERT ON admtaxi.notificacoes_push
FOR EACH ROW EXECUTE PROCEDURE admtaxi.enfileirar_fcm_android();
