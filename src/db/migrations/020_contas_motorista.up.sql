SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE admtaxi.contas_motorista (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nome VARCHAR(150) NOT NULL,
  email CITEXT NOT NULL, telefone VARCHAR(20), senha_hash TEXT NOT NULL,
  senha_versao INTEGER NOT NULL DEFAULT 0, deve_alterar_senha BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX contas_motorista_email_idx ON admtaxi.contas_motorista(email);
ALTER TABLE admtaxi.usuarios ADD COLUMN conta_motorista_id UUID REFERENCES admtaxi.contas_motorista(id);
CREATE UNIQUE INDEX usuarios_motorista_empresa_unico ON admtaxi.usuarios(conta_motorista_id,empresa_id);
-- Preserve distinct legacy identities. Never merge accounts by email alone.
INSERT INTO admtaxi.contas_motorista(id,nome,email,telefone,senha_hash,senha_versao,deve_alterar_senha)
SELECT id,nome,email,telefone,senha_hash,senha_versao,deve_alterar_senha FROM admtaxi.usuarios WHERE perfil='PRESTADOR';
UPDATE admtaxi.usuarios SET conta_motorista_id=id WHERE perfil='PRESTADOR';

CREATE FUNCTION admtaxi.vincular_conta_motorista() RETURNS TRIGGER AS $$
DECLARE conta admtaxi.contas_motorista%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.conta_motorista_id IS NOT NULL THEN
    IF NEW.conta_motorista_id IS DISTINCT FROM OLD.conta_motorista_id OR NEW.perfil<>'PRESTADOR' THEN
      RAISE EXCEPTION USING ERRCODE='P2001', MESSAGE='Este acesso pertence a uma conta de motorista. Inative somente o vinculo com a empresa.';
    END IF;
    IF NEW.senha_hash IS DISTINCT FROM OLD.senha_hash OR NEW.email IS DISTINCT FROM OLD.email THEN
      SELECT * INTO conta FROM admtaxi.contas_motorista WHERE id=OLD.conta_motorista_id FOR UPDATE;
      IF (SELECT count(*) FROM admtaxi.usuarios WHERE conta_motorista_id=conta.id)>1 THEN
        RAISE EXCEPTION USING ERRCODE='P2001', MESSAGE='Conta compartilhada: o motorista deve alterar a senha em Minha conta ou recuperar por email. O email de acesso nao pode ser alterado neste cadastro.';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtext('conta_motorista:' || lower(NEW.email::text)));
      IF EXISTS(SELECT 1 FROM admtaxi.contas_motorista WHERE email=NEW.email AND id<>conta.id) THEN
        RAISE EXCEPTION USING ERRCODE='P2001', MESSAGE='Este email ja pertence a outro motorista. Utilize Vincular motorista existente.';
      END IF;
      UPDATE admtaxi.contas_motorista SET email=NEW.email,
        senha_hash=CASE WHEN NEW.senha_hash IS DISTINCT FROM OLD.senha_hash THEN NEW.senha_hash ELSE senha_hash END,
        deve_alterar_senha=CASE WHEN NEW.senha_hash IS DISTINCT FROM OLD.senha_hash THEN NEW.deve_alterar_senha ELSE deve_alterar_senha END WHERE id=conta.id;
    END IF;
  ELSIF NEW.perfil='PRESTADOR' THEN
    IF NEW.conta_motorista_id IS NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('conta_motorista:' || lower(NEW.email::text)));
      IF EXISTS(SELECT 1 FROM admtaxi.contas_motorista WHERE email=NEW.email) THEN
        RAISE EXCEPTION USING ERRCODE='P2001', MESSAGE='Ja existe um motorista com este email. Utilize Vincular motorista existente para manter a mesma conta e senha.';
      END IF;
      INSERT INTO admtaxi.contas_motorista(nome,email,telefone,senha_hash,deve_alterar_senha)
      VALUES(NEW.nome,NEW.email,NEW.telefone,NEW.senha_hash,NEW.deve_alterar_senha) RETURNING id INTO NEW.conta_motorista_id;
    ELSE
      SELECT * INTO STRICT conta FROM admtaxi.contas_motorista WHERE id=NEW.conta_motorista_id FOR UPDATE;
      NEW.nome:=conta.nome; NEW.email:=conta.email; NEW.telefone:=conta.telefone;
      NEW.senha_hash:=conta.senha_hash; NEW.senha_versao:=conta.senha_versao; NEW.deve_alterar_senha:=conta.deve_alterar_senha;
    END IF;
  ELSIF NEW.conta_motorista_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P2001', MESSAGE='Somente motoristas podem compartilhar esta conta.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER usuarios_conta_motorista BEFORE INSERT OR UPDATE ON admtaxi.usuarios
FOR EACH ROW EXECUTE PROCEDURE admtaxi.vincular_conta_motorista();

CREATE FUNCTION admtaxi.revogar_sessoes_conta_motorista() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.senha_hash IS DISTINCT FROM OLD.senha_hash OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.senha_versao:=OLD.senha_versao+1;
    UPDATE admtaxi.refresh_tokens SET revogado_em=COALESCE(revogado_em,CURRENT_TIMESTAMP)
      WHERE usuario_id IN(SELECT id FROM admtaxi.usuarios WHERE conta_motorista_id=OLD.id);
    UPDATE admtaxi.recuperacoes_senha SET usado_em=COALESCE(usado_em,CURRENT_TIMESTAMP)
      WHERE usuario_id IN(SELECT id FROM admtaxi.usuarios WHERE conta_motorista_id=OLD.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER contas_motorista_revogar BEFORE UPDATE ON admtaxi.contas_motorista
FOR EACH ROW EXECUTE PROCEDURE admtaxi.revogar_sessoes_conta_motorista();

CREATE VIEW admtaxi.motorista_vinculos_ativos AS
SELECT u.conta_motorista_id AS conta_id,u.id AS usuario_id,u.empresa_id,p.id AS prestador_id,
  p.disponivel,e.nome_fantasia AS empresa_nome
FROM admtaxi.usuarios u JOIN admtaxi.empresas e ON e.id=u.empresa_id
JOIN admtaxi.prestadores p ON p.usuario_id=u.id AND p.empresa_id=u.empresa_id
WHERE u.conta_motorista_id IS NOT NULL AND u.perfil='PRESTADOR' AND u.ativo AND e.ativo AND p.ativo;

CREATE OR REPLACE VIEW admtaxi.usuarios_autenticacao AS
SELECT u.id,u.empresa_id,u.nome,COALESCE(m.email,c.email,u.email) AS email,
  COALESCE(m.senha_hash,c.senha_hash,u.senha_hash) AS senha_hash,u.perfil,u.ativo,
  COALESCE(m.senha_versao,c.senha_versao,u.senha_versao) AS senha_versao,
  COALESCE(m.deve_alterar_senha,c.deve_alterar_senha,u.deve_alterar_senha) AS deve_alterar_senha,
  u.conta_gestor_id,u.conta_motorista_id
FROM admtaxi.usuarios u LEFT JOIN admtaxi.contas_gestor c ON c.id=u.conta_gestor_id
LEFT JOIN admtaxi.contas_motorista m ON m.id=u.conta_motorista_id;

-- Keep notification ownership and subscription ownership separate, preserving all attempts.
ALTER TABLE admtaxi.push_tentativas ADD COLUMN subscription_empresa_id UUID;
UPDATE admtaxi.push_tentativas SET subscription_empresa_id=empresa_id;
ALTER TABLE admtaxi.push_tentativas ALTER COLUMN subscription_empresa_id SET NOT NULL;
ALTER TABLE admtaxi.push_tentativas DROP CONSTRAINT push_tentativas_subscription_fk;
ALTER TABLE admtaxi.push_tentativas ADD CONSTRAINT push_tentativas_subscription_fk
  FOREIGN KEY (subscription_empresa_id,subscription_id)
  REFERENCES admtaxi.push_subscriptions(empresa_id,id) ON DELETE RESTRICT;

CREATE FUNCTION admtaxi.validar_push_motorista() RETURNS TRIGGER AS $$
BEGIN
  -- Legacy senders still write a single company; cross-company sends require a shared account.
  NEW.subscription_empresa_id:=COALESCE(NEW.subscription_empresa_id,NEW.empresa_id);
  IF NEW.subscription_empresa_id<>NEW.empresa_id AND NOT EXISTS (
    SELECT 1 FROM admtaxi.notificacoes_push n
    JOIN admtaxi.motorista_vinculos_ativos m ON m.usuario_id=n.usuario_id AND m.empresa_id=n.empresa_id
    JOIN admtaxi.usuarios u ON u.conta_motorista_id=m.conta_id
    JOIN admtaxi.push_subscriptions ps ON ps.usuario_id=u.id AND ps.empresa_id=u.empresa_id
    WHERE n.id=NEW.notificacao_id AND n.empresa_id=NEW.empresa_id
      AND ps.id=NEW.subscription_id AND ps.empresa_id=NEW.subscription_empresa_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Notificacao e dispositivo devem pertencer a mesma conta de motorista.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER push_tentativas_motorista BEFORE INSERT OR UPDATE OF empresa_id,notificacao_id,subscription_empresa_id,subscription_id
ON admtaxi.push_tentativas FOR EACH ROW EXECUTE PROCEDURE admtaxi.validar_push_motorista();
