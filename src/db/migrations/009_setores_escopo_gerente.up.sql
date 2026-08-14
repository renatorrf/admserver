CREATE TABLE admtaxi.setores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  codigo VARCHAR(50) NOT NULL,
  nome VARCHAR(150) NOT NULL,
  descricao TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT setores_empresa_id_unico UNIQUE (empresa_id, id),
  CONSTRAINT setores_empresa_codigo_unico UNIQUE (empresa_id, codigo)
);

CREATE INDEX setores_empresa_ativo_idx ON admtaxi.setores (empresa_id, ativo, codigo);

CREATE TRIGGER setores_definir_atualizado_em
BEFORE UPDATE ON admtaxi.setores
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();

ALTER TABLE admtaxi.centros_custo
  ADD COLUMN setor_id UUID;

ALTER TABLE admtaxi.centros_custo
  ADD CONSTRAINT centros_custo_setor_fk
  FOREIGN KEY (empresa_id, setor_id)
  REFERENCES admtaxi.setores (empresa_id, id) ON DELETE RESTRICT;

CREATE INDEX centros_custo_setor_idx
  ON admtaxi.centros_custo (empresa_id, setor_id, ativo);

COMMENT ON COLUMN admtaxi.centros_custo.setor_id IS
  'Temporariamente anulavel apenas para centros anteriores a migration 009. Novos centros exigem setor pela API.';

CREATE TABLE admtaxi.gerente_setores (
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  gerente_usuario_id UUID NOT NULL,
  setor_id UUID NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (empresa_id, gerente_usuario_id, setor_id),
  CONSTRAINT gerente_setores_usuario_fk
    FOREIGN KEY (empresa_id, gerente_usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT gerente_setores_setor_fk
    FOREIGN KEY (empresa_id, setor_id)
    REFERENCES admtaxi.setores (empresa_id, id) ON DELETE RESTRICT
);

CREATE INDEX gerente_setores_setor_idx
  ON admtaxi.gerente_setores (empresa_id, setor_id);

CREATE FUNCTION admtaxi.validar_usuario_gerente()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM admtaxi.usuarios u
     WHERE u.empresa_id = NEW.empresa_id
       AND u.id = NEW.gerente_usuario_id
       AND u.perfil = 'GERENTE'
  ) THEN
    RAISE EXCEPTION 'O usuario vinculado deve possuir perfil GERENTE.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gerente_setores_validar_usuario
BEFORE INSERT OR UPDATE ON admtaxi.gerente_setores
FOR EACH ROW EXECUTE PROCEDURE admtaxi.validar_usuario_gerente();

CREATE TRIGGER gerente_centros_custo_validar_usuario
BEFORE INSERT OR UPDATE ON admtaxi.gerente_centros_custo
FOR EACH ROW EXECUTE PROCEDURE admtaxi.validar_usuario_gerente();

CREATE FUNCTION admtaxi.validar_gerente_centro_no_setor()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  centro_setor_id UUID;
BEGIN
  SELECT c.setor_id
    INTO centro_setor_id
    FROM admtaxi.centros_custo c
   WHERE c.empresa_id = NEW.empresa_id
     AND c.id = NEW.centro_custo_id;

  IF centro_setor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM admtaxi.gerente_setores gs
     WHERE gs.empresa_id = NEW.empresa_id
       AND gs.gerente_usuario_id = NEW.gerente_usuario_id
       AND gs.setor_id = centro_setor_id
  ) THEN
    RAISE EXCEPTION 'O centro de custo deve pertencer a um setor autorizado para o gerente.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gerente_centros_custo_validar_setor
BEFORE INSERT OR UPDATE ON admtaxi.gerente_centros_custo
FOR EACH ROW EXECUTE PROCEDURE admtaxi.validar_gerente_centro_no_setor();

CREATE FUNCTION admtaxi.validar_setor_do_centro_para_gerentes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.setor_id IS NOT NULL AND NEW.setor_id IS DISTINCT FROM OLD.setor_id AND EXISTS (
    SELECT 1
      FROM admtaxi.gerente_centros_custo gcc
     WHERE gcc.empresa_id = NEW.empresa_id
       AND gcc.centro_custo_id = NEW.id
       AND NOT EXISTS (
         SELECT 1
           FROM admtaxi.gerente_setores gs
          WHERE gs.empresa_id = gcc.empresa_id
            AND gs.gerente_usuario_id = gcc.gerente_usuario_id
            AND gs.setor_id = NEW.setor_id
       )
  ) THEN
    RAISE EXCEPTION 'Regularize os setores autorizados dos gerentes antes de vincular o centro de custo ao setor.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER centros_custo_validar_escopo_gerentes
BEFORE UPDATE OF setor_id ON admtaxi.centros_custo
FOR EACH ROW EXECUTE PROCEDURE admtaxi.validar_setor_do_centro_para_gerentes();

