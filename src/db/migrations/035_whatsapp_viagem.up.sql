CREATE TABLE admtaxi.whatsapp_viagem (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL,
  requisicao_id UUID NOT NULL,
  funcionario_id UUID NOT NULL,
  conferente_id UUID NOT NULL,
  telefone_hash TEXT NOT NULL CHECK (telefone_hash ~ '^[0-9a-f]{64}$'),
  tipo TEXT NOT NULL CHECK (tipo IN ('CORRIDA','PRIMEIRO_ACESSO')),
  status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN
    ('PENDENTE','ENVIANDO','ACEITO','ENVIADO','ENTREGUE','LIDO','FALHOU','INCERTO','IGNORADO')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  mensagem_id TEXT UNIQUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tentar_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (requisicao_id,funcionario_id,tipo),
  FOREIGN KEY (empresa_id,requisicao_id) REFERENCES admtaxi.requisicoes_viagem(empresa_id,id),
  FOREIGN KEY (empresa_id,funcionario_id) REFERENCES admtaxi.funcionarios(empresa_id,id),
  FOREIGN KEY (empresa_id,conferente_id) REFERENCES admtaxi.usuarios(empresa_id,id)
);
CREATE INDEX whatsapp_viagem_pendentes ON admtaxi.whatsapp_viagem(tentar_em,id) WHERE status='PENDENTE';
