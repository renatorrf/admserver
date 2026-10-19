-- Existing accounts stay usable; newly provisioned accounts require a personal password.
ALTER TABLE admtaxi.usuarios
  ADD COLUMN deve_alterar_senha BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN senha_versao INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admtaxi.usuarios ALTER COLUMN deve_alterar_senha SET DEFAULT TRUE;

CREATE TABLE admtaxi.recuperacoes_senha (
  token_hash CHAR(64) PRIMARY KEY,
  empresa_id UUID NOT NULL,
  usuario_id UUID NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expira_em TIMESTAMPTZ NOT NULL,
  usado_em TIMESTAMPTZ,
  FOREIGN KEY (empresa_id, usuario_id) REFERENCES admtaxi.usuarios (empresa_id, id)
);
CREATE INDEX recuperacoes_senha_usuario_idx
  ON admtaxi.recuperacoes_senha (empresa_id, usuario_id, criado_em);

-- Covers every password writer, including administrative/unified registrations.
CREATE FUNCTION admtaxi.revogar_sessoes_senha() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.senha_hash IS DISTINCT FROM OLD.senha_hash THEN
    NEW.senha_versao := OLD.senha_versao + 1;
    UPDATE admtaxi.refresh_tokens SET revogado_em = COALESCE(revogado_em, CURRENT_TIMESTAMP)
      WHERE empresa_id = OLD.empresa_id AND usuario_id = OLD.id;
    UPDATE admtaxi.recuperacoes_senha SET usado_em = COALESCE(usado_em, CURRENT_TIMESTAMP)
      WHERE empresa_id = OLD.empresa_id AND usuario_id = OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER usuarios_revogar_sessoes_senha
  BEFORE UPDATE OF senha_hash ON admtaxi.usuarios
  FOR EACH ROW EXECUTE PROCEDURE admtaxi.revogar_sessoes_senha();
