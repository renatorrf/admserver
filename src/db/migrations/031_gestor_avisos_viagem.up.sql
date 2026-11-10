SET LOCAL lock_timeout = '10s';

ALTER TABLE admtaxi.usuarios
  ADD COLUMN recebe_avisos_viagem BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX notificacoes_viagem_pendentes_idx ON admtaxi.notificacoes_push (criado_em,id)
  WHERE status='PENDENTE' AND left(tipo_payload,7)='VIAGEM_';
