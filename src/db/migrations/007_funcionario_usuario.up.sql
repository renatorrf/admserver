ALTER TYPE admtaxi.perfil_usuario RENAME TO perfil_usuario_anterior;
CREATE TYPE admtaxi.perfil_usuario AS ENUM ('PRESTADOR', 'FUNCIONARIO', 'GERENTE', 'GESTOR');

ALTER TABLE admtaxi.usuarios
  ALTER COLUMN perfil TYPE admtaxi.perfil_usuario
  USING perfil::TEXT::admtaxi.perfil_usuario;

DROP TYPE admtaxi.perfil_usuario_anterior;

ALTER TABLE admtaxi.funcionarios
  ADD COLUMN usuario_id UUID,
  ADD CONSTRAINT funcionarios_empresa_usuario_unico UNIQUE (empresa_id, usuario_id),
  ADD CONSTRAINT funcionarios_usuario_fk
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT;

CREATE INDEX funcionarios_usuario_idx ON admtaxi.funcionarios (empresa_id, usuario_id);
