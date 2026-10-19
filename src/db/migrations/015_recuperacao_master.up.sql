ALTER TABLE admtaxi.administradores_plataforma
  ADD COLUMN email CITEXT UNIQUE,
  ADD COLUMN senha_versao INTEGER NOT NULL DEFAULT 0;

CREATE TABLE admtaxi.recuperacoes_senha_master (
  token_hash CHAR(64) PRIMARY KEY,
  administrador_id UUID NOT NULL REFERENCES admtaxi.administradores_plataforma(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expira_em TIMESTAMPTZ NOT NULL,
  usado_em TIMESTAMPTZ
);
CREATE INDEX recuperacoes_master_administrador_idx
  ON admtaxi.recuperacoes_senha_master (administrador_id, criado_em);

CREATE FUNCTION admtaxi.revogar_sessoes_master() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.senha_hash IS DISTINCT FROM OLD.senha_hash
    OR NEW.email IS DISTINCT FROM OLD.email OR NEW.ativo IS DISTINCT FROM OLD.ativo THEN
    NEW.senha_versao := OLD.senha_versao + 1;
    UPDATE admtaxi.recuperacoes_senha_master SET usado_em=COALESCE(usado_em,CURRENT_TIMESTAMP)
      WHERE administrador_id=OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER administradores_revogar_sessoes
  BEFORE UPDATE OF senha_hash,email,ativo ON admtaxi.administradores_plataforma
  FOR EACH ROW EXECUTE PROCEDURE admtaxi.revogar_sessoes_master();
