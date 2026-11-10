SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE VIEW admtaxi.fcm_destinatarios AS
 SELECT d.*,owner.empresa_id AS destino_empresa_id,owner.id AS destino_usuario_id
 FROM admtaxi.dispositivos_push d
 JOIN admtaxi.usuarios_autenticacao owner ON owner.empresa_id=d.empresa_id AND owner.id=d.usuario_id
 JOIN admtaxi.empresas e ON e.id=owner.empresa_id AND e.ativo
 WHERE d.ativo AND d.plataforma='ANDROID' AND d.vinculo_id IS NOT NULL
   AND owner.ativo AND owner.senha_versao=d.senha_versao AND NOT owner.deve_alterar_senha
   AND (owner.perfil IN ('FUNCIONARIO','GERENTE','GESTOR','PORTARIA')
     OR (owner.perfil='PRESTADOR' AND EXISTS (
       SELECT 1 FROM admtaxi.motorista_vinculos_ativos m WHERE m.empresa_id=owner.empresa_id AND m.usuario_id=owner.id
     )));
