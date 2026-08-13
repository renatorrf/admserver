CREATE TABLE admtaxi.prestadores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  usuario_id UUID,
  nome VARCHAR(150) NOT NULL,
  cpf VARCHAR(11) NOT NULL,
  telefone VARCHAR(20) NOT NULL,
  email CITEXT,
  numero_cnh VARCHAR(20) NOT NULL,
  validade_cnh DATE NOT NULL,
  disponivel BOOLEAN NOT NULL DEFAULT FALSE,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT prestadores_empresa_id_unico UNIQUE (empresa_id, id),
  CONSTRAINT prestadores_empresa_cpf_unico UNIQUE (empresa_id, cpf),
  CONSTRAINT prestadores_empresa_cnh_unico UNIQUE (empresa_id, numero_cnh),
  CONSTRAINT prestadores_empresa_usuario_unico UNIQUE (empresa_id, usuario_id),
  CONSTRAINT prestadores_usuario_fk
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT prestadores_cpf_formato CHECK (cpf ~ '^[0-9]{11}$')
);

CREATE INDEX prestadores_empresa_ativo_idx ON admtaxi.prestadores (empresa_id, ativo);
CREATE INDEX prestadores_empresa_disponivel_idx ON admtaxi.prestadores (empresa_id, disponivel) WHERE ativo;
CREATE INDEX prestadores_email_idx ON admtaxi.prestadores (empresa_id, email);

CREATE TABLE admtaxi.veiculos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  prestador_id UUID,
  placa VARCHAR(7) NOT NULL,
  marca VARCHAR(80) NOT NULL,
  modelo VARCHAR(100) NOT NULL,
  cor VARCHAR(50) NOT NULL,
  ano SMALLINT NOT NULL,
  capacidade_passageiros SMALLINT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT veiculos_empresa_id_unico UNIQUE (empresa_id, id),
  CONSTRAINT veiculos_empresa_placa_unico UNIQUE (empresa_id, placa),
  CONSTRAINT veiculos_prestador_fk
    FOREIGN KEY (empresa_id, prestador_id)
    REFERENCES admtaxi.prestadores (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT veiculos_placa_formato CHECK (placa ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'),
  CONSTRAINT veiculos_ano_valido CHECK (ano BETWEEN 1900 AND 2100),
  CONSTRAINT veiculos_capacidade_valida CHECK (capacidade_passageiros BETWEEN 1 AND 99)
);

CREATE INDEX veiculos_empresa_ativo_idx ON admtaxi.veiculos (empresa_id, ativo);
CREATE INDEX veiculos_prestador_idx ON admtaxi.veiculos (empresa_id, prestador_id);
CREATE INDEX veiculos_placa_idx ON admtaxi.veiculos (placa);

CREATE TABLE admtaxi.centros_custo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  codigo VARCHAR(50) NOT NULL,
  nome VARCHAR(150) NOT NULL,
  descricao TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT centros_custo_empresa_id_unico UNIQUE (empresa_id, id),
  CONSTRAINT centros_custo_empresa_codigo_unico UNIQUE (empresa_id, codigo)
);

CREATE INDEX centros_custo_empresa_ativo_idx ON admtaxi.centros_custo (empresa_id, ativo);

CREATE TABLE admtaxi.funcionarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  centro_custo_id UUID NOT NULL,
  nome VARCHAR(150) NOT NULL,
  matricula VARCHAR(50) NOT NULL,
  cpf VARCHAR(11),
  telefone VARCHAR(20),
  email CITEXT,
  endereco_padrao TEXT,
  latitude_padrao NUMERIC(9, 6),
  longitude_padrao NUMERIC(9, 6),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT funcionarios_empresa_id_unico UNIQUE (empresa_id, id),
  CONSTRAINT funcionarios_empresa_matricula_unico UNIQUE (empresa_id, matricula),
  CONSTRAINT funcionarios_empresa_cpf_unico UNIQUE (empresa_id, cpf),
  CONSTRAINT funcionarios_centro_custo_fk
    FOREIGN KEY (empresa_id, centro_custo_id)
    REFERENCES admtaxi.centros_custo (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT funcionarios_cpf_formato CHECK (cpf IS NULL OR cpf ~ '^[0-9]{11}$'),
  CONSTRAINT funcionarios_latitude_valida CHECK (latitude_padrao IS NULL OR latitude_padrao BETWEEN -90 AND 90),
  CONSTRAINT funcionarios_longitude_valida CHECK (longitude_padrao IS NULL OR longitude_padrao BETWEEN -180 AND 180),
  CONSTRAINT funcionarios_coordenadas_completas CHECK ((latitude_padrao IS NULL) = (longitude_padrao IS NULL))
);

CREATE INDEX funcionarios_empresa_ativo_idx ON admtaxi.funcionarios (empresa_id, ativo);
CREATE INDEX funcionarios_centro_custo_idx ON admtaxi.funcionarios (empresa_id, centro_custo_id);
CREATE INDEX funcionarios_email_idx ON admtaxi.funcionarios (empresa_id, email);

CREATE TABLE admtaxi.gerente_centros_custo (
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id) ON DELETE RESTRICT,
  gerente_usuario_id UUID NOT NULL,
  centro_custo_id UUID NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (empresa_id, gerente_usuario_id, centro_custo_id),
  CONSTRAINT gerente_centros_custo_usuario_fk
    FOREIGN KEY (empresa_id, gerente_usuario_id)
    REFERENCES admtaxi.usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT gerente_centros_custo_centro_fk
    FOREIGN KEY (empresa_id, centro_custo_id)
    REFERENCES admtaxi.centros_custo (empresa_id, id) ON DELETE RESTRICT
);

CREATE INDEX gerente_centros_custo_centro_idx
  ON admtaxi.gerente_centros_custo (empresa_id, centro_custo_id);
