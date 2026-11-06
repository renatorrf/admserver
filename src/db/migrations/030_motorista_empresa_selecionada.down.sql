CREATE OR REPLACE VIEW admtaxi.fcm_destinatarios AS
 SELECT d.*,r.empresa_id AS destino_empresa_id,r.id AS destino_usuario_id
 FROM admtaxi.dispositivos_push d
 JOIN admtaxi.usuarios_autenticacao owner ON owner.empresa_id=d.empresa_id AND owner.id=d.usuario_id
 JOIN admtaxi.usuarios r ON r.perfil='PRESTADOR' AND (r.id=owner.id OR
   (owner.conta_motorista_id IS NOT NULL AND r.conta_motorista_id=owner.conta_motorista_id))
 JOIN admtaxi.motorista_vinculos_ativos m ON m.usuario_id=r.id AND m.empresa_id=r.empresa_id
 WHERE d.ativo AND d.plataforma='ANDROID' AND d.vinculo_id IS NOT NULL
   AND owner.perfil='PRESTADOR' AND owner.senha_versao=d.senha_versao AND NOT owner.deve_alterar_senha;
