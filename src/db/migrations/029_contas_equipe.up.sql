SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE admtaxi.contas_equipe (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nome VARCHAR(150) NOT NULL,
  email CITEXT NOT NULL, telefone VARCHAR(20), senha_hash TEXT NOT NULL,
  senha_versao INTEGER NOT NULL DEFAULT 0, deve_alterar_senha BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX contas_equipe_email_idx ON admtaxi.contas_equipe(email);
ALTER TABLE admtaxi.usuarios ADD COLUMN conta_equipe_id UUID REFERENCES admtaxi.contas_equipe(id);
CREATE UNIQUE INDEX usuarios_equipe_empresa_unico ON admtaxi.usuarios(conta_equipe_id,empresa_id);
-- Preserve independent legacy identities, including repeated emails.
INSERT INTO admtaxi.contas_equipe(id,nome,email,telefone,senha_hash,senha_versao,deve_alterar_senha)
SELECT id,nome,email,telefone,senha_hash,senha_versao,deve_alterar_senha FROM admtaxi.usuarios WHERE perfil IN ('GERENTE','PORTARIA');
UPDATE admtaxi.usuarios SET conta_equipe_id=id WHERE perfil IN ('GERENTE','PORTARIA');

CREATE FUNCTION admtaxi.vincular_conta_equipe() RETURNS TRIGGER AS $$
DECLARE conta admtaxi.contas_equipe%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.conta_equipe_id IS NOT NULL THEN
    IF NEW.conta_equipe_id IS DISTINCT FROM OLD.conta_equipe_id OR NEW.perfil NOT IN ('GERENTE','PORTARIA') THEN
      RAISE EXCEPTION USING ERRCODE='P2901', MESSAGE='Esta conta pertence a Supervisor ou Portaria. Inative somente o vinculo com a empresa.';
    END IF;
    IF NEW.senha_hash IS DISTINCT FROM OLD.senha_hash OR NEW.email IS DISTINCT FROM OLD.email THEN
      SELECT * INTO conta FROM admtaxi.contas_equipe WHERE id=OLD.conta_equipe_id FOR UPDATE;
      IF (SELECT count(*) FROM admtaxi.usuarios WHERE conta_equipe_id=conta.id)>1 THEN
        RAISE EXCEPTION USING ERRCODE='P2901', MESSAGE='Conta vinculada a varias empresas: altere a senha em Minha conta ou recupere por email. O email nao pode ser alterado neste cadastro.';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtext('conta_equipe:' || lower(NEW.email::text)));
      IF EXISTS(SELECT 1 FROM admtaxi.contas_equipe WHERE email=NEW.email AND id<>conta.id) THEN
        RAISE EXCEPTION USING ERRCODE='P2901', MESSAGE='Este email ja pertence a outra conta. Utilize Vincular usuario existente.';
      END IF;
      UPDATE admtaxi.contas_equipe SET email=NEW.email,
        senha_hash=CASE WHEN NEW.senha_hash IS DISTINCT FROM OLD.senha_hash THEN NEW.senha_hash ELSE senha_hash END,
        deve_alterar_senha=CASE WHEN NEW.senha_hash IS DISTINCT FROM OLD.senha_hash THEN NEW.deve_alterar_senha ELSE deve_alterar_senha END WHERE id=conta.id;
    END IF;
  ELSIF NEW.perfil IN ('GERENTE','PORTARIA') THEN
    IF NEW.conta_equipe_id IS NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('conta_equipe:' || lower(NEW.email::text)));
      IF EXISTS(SELECT 1 FROM admtaxi.contas_equipe WHERE email=NEW.email) THEN
        RAISE EXCEPTION USING ERRCODE='P2901', MESSAGE='Ja existe uma conta com este email. Utilize Vincular usuario existente para manter a mesma conta e senha.';
      END IF;
      INSERT INTO admtaxi.contas_equipe(nome,email,telefone,senha_hash,deve_alterar_senha)
      VALUES(NEW.nome,NEW.email,NEW.telefone,NEW.senha_hash,NEW.deve_alterar_senha) RETURNING id INTO NEW.conta_equipe_id;
    ELSE
      SELECT * INTO STRICT conta FROM admtaxi.contas_equipe WHERE id=NEW.conta_equipe_id FOR UPDATE;
      NEW.nome:=conta.nome; NEW.email:=conta.email; NEW.telefone:=conta.telefone;
      NEW.senha_hash:=conta.senha_hash; NEW.senha_versao:=conta.senha_versao; NEW.deve_alterar_senha:=conta.deve_alterar_senha;
    END IF;
  ELSIF NEW.conta_equipe_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P2901', MESSAGE='Somente Supervisor e Portaria podem compartilhar esta conta.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER usuarios_conta_equipe BEFORE INSERT OR UPDATE ON admtaxi.usuarios
FOR EACH ROW EXECUTE PROCEDURE admtaxi.vincular_conta_equipe();

CREATE FUNCTION admtaxi.revogar_sessoes_conta_equipe() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.senha_hash IS DISTINCT FROM OLD.senha_hash OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.senha_versao:=OLD.senha_versao+1;
    UPDATE admtaxi.refresh_tokens SET revogado_em=COALESCE(revogado_em,CURRENT_TIMESTAMP)
      WHERE usuario_id IN(SELECT id FROM admtaxi.usuarios WHERE conta_equipe_id=OLD.id);
    UPDATE admtaxi.recuperacoes_senha SET usado_em=COALESCE(usado_em,CURRENT_TIMESTAMP)
      WHERE usuario_id IN(SELECT id FROM admtaxi.usuarios WHERE conta_equipe_id=OLD.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER contas_equipe_revogar BEFORE UPDATE ON admtaxi.contas_equipe
FOR EACH ROW EXECUTE PROCEDURE admtaxi.revogar_sessoes_conta_equipe();

CREATE OR REPLACE VIEW admtaxi.usuarios_autenticacao AS
SELECT u.id,u.empresa_id,u.nome,COALESCE(t.email,f.email,m.email,c.email,u.email) AS email,
  COALESCE(t.senha_hash,f.senha_hash,m.senha_hash,c.senha_hash,u.senha_hash) AS senha_hash,u.perfil,u.ativo,
  COALESCE(t.senha_versao,f.senha_versao,m.senha_versao,c.senha_versao,u.senha_versao) AS senha_versao,
  COALESCE(t.deve_alterar_senha,f.deve_alterar_senha,m.deve_alterar_senha,c.deve_alterar_senha,u.deve_alterar_senha) AS deve_alterar_senha,
  u.conta_gestor_id,u.conta_motorista_id,u.conta_funcionario_id,u.conta_equipe_id
FROM admtaxi.usuarios u LEFT JOIN admtaxi.contas_gestor c ON c.id=u.conta_gestor_id
LEFT JOIN admtaxi.contas_motorista m ON m.id=u.conta_motorista_id
LEFT JOIN admtaxi.contas_funcionario f ON f.id=u.conta_funcionario_id
LEFT JOIN admtaxi.contas_equipe t ON t.id=u.conta_equipe_id;
