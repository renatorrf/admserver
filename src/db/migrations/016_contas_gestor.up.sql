-- Credentials belong to an account; usuarios remains the tenant-scoped membership.
CREATE TABLE admtaxi.contas_gestor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome VARCHAR(150) NOT NULL,
  email CITEXT NOT NULL,
  telefone VARCHAR(20),
  senha_hash TEXT NOT NULL,
  senha_versao INTEGER NOT NULL DEFAULT 0,
  deve_alterar_senha BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX contas_gestor_email_idx ON admtaxi.contas_gestor(email);
ALTER TABLE admtaxi.usuarios ADD COLUMN conta_gestor_id UUID REFERENCES admtaxi.contas_gestor(id);
CREATE UNIQUE INDEX usuarios_conta_empresa_unico ON admtaxi.usuarios(conta_gestor_id,empresa_id);
-- Do not merge legacy accounts merely because they share an email address.
INSERT INTO admtaxi.contas_gestor(id,nome,email,telefone,senha_hash,senha_versao,deve_alterar_senha)
SELECT id,nome,email,telefone,senha_hash,senha_versao,deve_alterar_senha FROM admtaxi.usuarios WHERE perfil='GESTOR';
UPDATE admtaxi.usuarios SET conta_gestor_id=id WHERE perfil='GESTOR';

CREATE FUNCTION admtaxi.vincular_conta_gestor() RETURNS TRIGGER AS $$
DECLARE conta admtaxi.contas_gestor%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.conta_gestor_id IS NOT NULL THEN
    IF NEW.conta_gestor_id IS DISTINCT FROM OLD.conta_gestor_id OR NEW.perfil <> 'GESTOR' THEN
      RAISE EXCEPTION USING ERRCODE='P1601', MESSAGE='O perfil desta conta e gestor. Inative apenas o vinculo com a empresa.';
    END IF;
    IF NEW.senha_hash IS DISTINCT FROM OLD.senha_hash OR NEW.email IS DISTINCT FROM OLD.email THEN
      SELECT * INTO conta FROM admtaxi.contas_gestor WHERE id=OLD.conta_gestor_id FOR UPDATE;
      IF (SELECT COUNT(*) FROM admtaxi.usuarios WHERE conta_gestor_id=conta.id)>1 THEN
        RAISE EXCEPTION USING ERRCODE='P1601', MESSAGE='Conta compartilhada: a senha deve ser alterada pelo titular em Minha conta ou pela recuperacao de senha. O email nao pode ser alterado neste cadastro.';
      END IF;
      IF NEW.email IS DISTINCT FROM OLD.email THEN
        PERFORM pg_advisory_xact_lock(hashtext('conta_gestor:' || lower(NEW.email::text)));
        IF EXISTS(SELECT 1 FROM admtaxi.contas_gestor WHERE email=NEW.email AND id<>conta.id) THEN
          RAISE EXCEPTION USING ERRCODE='P1601', MESSAGE='Este email pertence a outra conta de gestor.';
        END IF;
      END IF;
      UPDATE admtaxi.contas_gestor SET senha_hash=CASE WHEN NEW.senha_hash IS DISTINCT FROM OLD.senha_hash THEN NEW.senha_hash ELSE senha_hash END,
        email=NEW.email, deve_alterar_senha=CASE WHEN NEW.senha_hash IS DISTINCT FROM OLD.senha_hash THEN NEW.deve_alterar_senha ELSE deve_alterar_senha END
        WHERE id=conta.id;
    END IF;
  ELSIF NEW.perfil='GESTOR' THEN
    IF NEW.conta_gestor_id IS NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('conta_gestor:' || lower(NEW.email::text)));
      IF EXISTS(SELECT 1 FROM admtaxi.contas_gestor WHERE email=NEW.email) THEN
        RAISE EXCEPTION USING ERRCODE='P1601', MESSAGE='Ja existe uma conta de gestor com este email. Solicite o vinculo pelo portal master em Selecionar existente.';
      END IF;
      INSERT INTO admtaxi.contas_gestor(nome,email,telefone,senha_hash,deve_alterar_senha)
        VALUES(NEW.nome,NEW.email,NEW.telefone,NEW.senha_hash,NEW.deve_alterar_senha) RETURNING id INTO NEW.conta_gestor_id;
    ELSE
      SELECT * INTO STRICT conta FROM admtaxi.contas_gestor WHERE id=NEW.conta_gestor_id FOR UPDATE;
      NEW.nome:=conta.nome; NEW.email:=conta.email; NEW.telefone:=conta.telefone;
      NEW.senha_hash:=conta.senha_hash; NEW.senha_versao:=conta.senha_versao; NEW.deve_alterar_senha:=conta.deve_alterar_senha;
    END IF;
  ELSIF NEW.conta_gestor_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P1601', MESSAGE='Somente gestores podem vincular uma conta de gestor.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER usuarios_conta_gestor BEFORE INSERT OR UPDATE ON admtaxi.usuarios
  FOR EACH ROW EXECUTE PROCEDURE admtaxi.vincular_conta_gestor();

CREATE FUNCTION admtaxi.revogar_sessoes_conta_gestor() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.senha_hash IS DISTINCT FROM OLD.senha_hash OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.senha_versao:=OLD.senha_versao+1;
    UPDATE admtaxi.refresh_tokens SET revogado_em=COALESCE(revogado_em,CURRENT_TIMESTAMP)
      WHERE usuario_id IN(SELECT id FROM admtaxi.usuarios WHERE conta_gestor_id=OLD.id);
    UPDATE admtaxi.recuperacoes_senha SET usado_em=COALESCE(usado_em,CURRENT_TIMESTAMP)
      WHERE usuario_id IN(SELECT id FROM admtaxi.usuarios WHERE conta_gestor_id=OLD.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER contas_gestor_revogar BEFORE UPDATE ON admtaxi.contas_gestor
  FOR EACH ROW EXECUTE PROCEDURE admtaxi.revogar_sessoes_conta_gestor();

CREATE VIEW admtaxi.usuarios_autenticacao AS
SELECT u.id,u.empresa_id,u.nome,COALESCE(c.email,u.email) AS email,
  COALESCE(c.senha_hash,u.senha_hash) AS senha_hash,u.perfil,u.ativo,
  COALESCE(c.senha_versao,u.senha_versao) AS senha_versao,
  COALESCE(c.deve_alterar_senha,u.deve_alterar_senha) AS deve_alterar_senha,u.conta_gestor_id
FROM admtaxi.usuarios u LEFT JOIN admtaxi.contas_gestor c ON c.id=u.conta_gestor_id;
