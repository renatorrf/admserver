DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM admtaxi.usuarios WHERE perfil::TEXT = 'FUNCIONARIO') THEN
    RAISE EXCEPTION 'Nao e possivel remover o perfil FUNCIONARIO enquanto existirem usuarios vinculados.';
  END IF;
END
$$;

DROP INDEX admtaxi.funcionarios_usuario_idx;
ALTER TABLE admtaxi.funcionarios
  DROP CONSTRAINT funcionarios_usuario_fk,
  DROP CONSTRAINT funcionarios_empresa_usuario_unico,
  DROP COLUMN usuario_id;

ALTER TYPE admtaxi.perfil_usuario RENAME TO perfil_usuario_com_funcionario;
CREATE TYPE admtaxi.perfil_usuario AS ENUM ('PRESTADOR', 'GERENTE', 'GESTOR');

ALTER TABLE admtaxi.usuarios
  ALTER COLUMN perfil TYPE admtaxi.perfil_usuario
  USING perfil::TEXT::admtaxi.perfil_usuario;

DROP TYPE admtaxi.perfil_usuario_com_funcionario;
