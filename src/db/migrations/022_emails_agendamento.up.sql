SET LOCAL lock_timeout = '10s';
CREATE TABLE admtaxi.emails_agendamento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL,
  corrida_id UUID NOT NULL,
  funcionario_id UUID NOT NULL,
  destinatario TEXT,
  assunto TEXT NOT NULL,
  corpo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','ENVIANDO','ENVIADO','FALHOU','IGNORADO','SEM_EMAIL')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reserva UUID,
  reservada_ate TIMESTAMPTZ,
  ultimo_erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  enviado_em TIMESTAMPTZ,
  UNIQUE (empresa_id,corrida_id,funcionario_id),
  FOREIGN KEY (empresa_id,corrida_id) REFERENCES admtaxi.corridas(empresa_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id,funcionario_id) REFERENCES admtaxi.funcionarios(empresa_id,id) ON DELETE RESTRICT
);
CREATE INDEX emails_agendamento_pendentes ON admtaxi.emails_agendamento(proxima_tentativa_em)
  WHERE status IN ('PENDENTE','ENVIANDO');
