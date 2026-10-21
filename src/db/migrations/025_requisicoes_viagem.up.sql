CREATE TABLE admtaxi.requisicoes_viagem (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES admtaxi.empresas(id),
  solicitante_id UUID NOT NULL,
  chave UUID NOT NULL,
  conteudo_hash TEXT NOT NULL,
  dados JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDENTE','AUTORIZADA','REJEITADA','SOLICITADA')),
  decisor_id UUID,
  motivo TEXT,
  decidida_em TIMESTAMPTZ,
  conferente_id UUID,
  corrida_id UUID,
  criada_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizada_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (empresa_id,id),
  UNIQUE (empresa_id,solicitante_id,chave),
  UNIQUE (empresa_id,corrida_id),
  FOREIGN KEY (empresa_id,solicitante_id) REFERENCES admtaxi.usuarios(empresa_id,id),
  FOREIGN KEY (empresa_id,decisor_id) REFERENCES admtaxi.usuarios(empresa_id,id),
  FOREIGN KEY (empresa_id,conferente_id) REFERENCES admtaxi.usuarios(empresa_id,id),
  FOREIGN KEY (empresa_id,corrida_id) REFERENCES admtaxi.corridas(empresa_id,id),
  CHECK ((status='SOLICITADA') = (corrida_id IS NOT NULL))
);
CREATE INDEX requisicoes_empresa_status ON admtaxi.requisicoes_viagem(empresa_id,status,criada_em DESC);
CREATE TABLE admtaxi.emails_viagem (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL,
  requisicao_id UUID NOT NULL,
  evento TEXT NOT NULL,
  destinatario TEXT NOT NULL,
  assunto TEXT NOT NULL,
  corpo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','ENVIANDO','ENVIADO','FALHOU')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reserva UUID,
  reservada_ate TIMESTAMPTZ,
  enviado_em TIMESTAMPTZ,
  ultimo_erro TEXT,
  UNIQUE (requisicao_id,evento,destinatario),
  FOREIGN KEY (empresa_id,requisicao_id) REFERENCES admtaxi.requisicoes_viagem(empresa_id,id)
);
CREATE INDEX emails_viagem_pendentes ON admtaxi.emails_viagem(status,proxima_tentativa_em);
