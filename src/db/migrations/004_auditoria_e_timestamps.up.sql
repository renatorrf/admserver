CREATE TABLE admtaxi.auditoria (
  id BIGSERIAL PRIMARY KEY,
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  usuario_id UUID,
  entidade VARCHAR(80) NOT NULL,
  entidade_id TEXT NOT NULL,
  acao VARCHAR(50) NOT NULL,
  dados_anteriores JSONB,
  dados_novos JSONB,
  ip INET,
  user_agent TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT auditoria_usuario_fk
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT auditoria_dados_anteriores_objeto CHECK (
    dados_anteriores IS NULL OR jsonb_typeof(dados_anteriores) = 'object'
  ),
  CONSTRAINT auditoria_dados_novos_objeto CHECK (
    dados_novos IS NULL OR jsonb_typeof(dados_novos) = 'object'
  )
);

CREATE INDEX auditoria_empresa_data_idx ON admtaxi.auditoria (empresa_id, criado_em DESC);
CREATE INDEX auditoria_entidade_idx ON admtaxi.auditoria (empresa_id, entidade, entidade_id, criado_em DESC);
CREATE INDEX auditoria_usuario_idx ON admtaxi.auditoria (empresa_id, usuario_id, criado_em DESC);

CREATE FUNCTION admtaxi.definir_atualizado_em()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.atualizado_em = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER empresas_definir_atualizado_em
BEFORE UPDATE ON admtaxi.empresas
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();

CREATE TRIGGER usuarios_definir_atualizado_em
BEFORE UPDATE ON admtaxi.usuarios
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();

CREATE TRIGGER prestadores_definir_atualizado_em
BEFORE UPDATE ON admtaxi.prestadores
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();

CREATE TRIGGER veiculos_definir_atualizado_em
BEFORE UPDATE ON admtaxi.veiculos
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();

CREATE TRIGGER centros_custo_definir_atualizado_em
BEFORE UPDATE ON admtaxi.centros_custo
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();

CREATE TRIGGER funcionarios_definir_atualizado_em
BEFORE UPDATE ON admtaxi.funcionarios
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();

CREATE TRIGGER corridas_definir_atualizado_em
BEFORE UPDATE ON admtaxi.corridas
FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_atualizado_em();
