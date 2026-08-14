DROP TRIGGER IF EXISTS push_subscriptions_definir_atualizado_em ON admtaxi.push_subscriptions;
ALTER TABLE admtaxi.notificacoes_push DROP COLUMN IF EXISTS tipo_payload;
ALTER TABLE admtaxi.notificacoes_push DROP COLUMN IF EXISTS url_abertura;
DROP TABLE IF EXISTS admtaxi.push_tentativas;
ALTER TABLE admtaxi.notificacoes_push DROP CONSTRAINT IF EXISTS notificacoes_push_empresa_id_unico;
DROP TABLE IF EXISTS admtaxi.push_subscriptions;
ALTER TABLE admtaxi.prestadores DROP CONSTRAINT IF EXISTS prestadores_estado_operacao_formato;
ALTER TABLE admtaxi.prestadores DROP COLUMN IF EXISTS estado_operacao;
ALTER TABLE admtaxi.prestadores DROP COLUMN IF EXISTS cidade_operacao;
