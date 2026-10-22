SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

-- Avulsos use the existing passenger relationships, without creating an access account.
ALTER TABLE admtaxi.funcionarios ADD COLUMN avulso BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admtaxi.funcionarios ALTER COLUMN matricula DROP NOT NULL;
ALTER TABLE admtaxi.funcionarios ADD CONSTRAINT funcionarios_tipo_cadastro CHECK (
  (NOT avulso AND matricula IS NOT NULL) OR
  (avulso AND matricula IS NULL AND usuario_id IS NULL AND cpf IS NULL AND email IS NULL AND telefone IS NOT NULL));
ALTER TABLE admtaxi.funcionarios ADD COLUMN identidade_transporte TEXT;

UPDATE admtaxi.funcionarios f SET identidade_transporte=COALESCE(
  (SELECT 'conta:'||u.conta_funcionario_id::text FROM admtaxi.usuarios u WHERE u.id=f.usuario_id AND u.conta_funcionario_id IS NOT NULL),
  CASE WHEN f.cpf IS NOT NULL THEN 'cpf:'||f.cpf END,
  CASE WHEN admtaxi.normalizar_cadastro(f.telefone,'telefone') IS NOT NULL THEN
    'contato:'||md5(admtaxi.normalizar_cadastro(f.nome,'nome')||':'||admtaxi.normalizar_cadastro(f.telefone,'telefone')) END,
  'registro:'||f.id::text);
ALTER TABLE admtaxi.funcionarios ALTER COLUMN identidade_transporte SET NOT NULL;
CREATE INDEX funcionarios_identidade_transporte_idx ON admtaxi.funcionarios(identidade_transporte);

CREATE FUNCTION admtaxi.identificar_passageiro() RETURNS TRIGGER AS $$
DECLARE conta UUID; identidade TEXT;
BEGIN
  -- Identity is stable when contact details are edited; account linking is not inferred from names.
  IF TG_OP='UPDATE' THEN NEW.identidade_transporte=OLD.identidade_transporte; RETURN NEW; END IF;
  SELECT conta_funcionario_id INTO conta FROM admtaxi.usuarios WHERE id=NEW.usuario_id;
  PERFORM pg_advisory_xact_lock(hashtext('plano_passageiros'),0);
  SELECT f.identidade_transporte INTO identidade FROM admtaxi.funcionarios f
    LEFT JOIN admtaxi.usuarios u ON u.id=f.usuario_id
    WHERE (conta IS NOT NULL AND u.conta_funcionario_id=conta)
       OR (NEW.cpf IS NOT NULL AND f.cpf=NEW.cpf)
       OR (admtaxi.normalizar_cadastro(NEW.telefone,'telefone') IS NOT NULL
         AND admtaxi.normalizar_cadastro(f.telefone,'telefone')=admtaxi.normalizar_cadastro(NEW.telefone,'telefone')
         AND admtaxi.normalizar_cadastro(f.nome,'nome')=admtaxi.normalizar_cadastro(NEW.nome,'nome'))
    ORDER BY (conta IS NOT NULL AND u.conta_funcionario_id=conta) DESC NULLS LAST,f.criado_em,f.id LIMIT 1;
  NEW.identidade_transporte=COALESCE(identidade,'registro:'||NEW.id::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER funcionarios_identidade_transporte BEFORE INSERT OR UPDATE ON admtaxi.funcionarios
  FOR EACH ROW EXECUTE PROCEDURE admtaxi.identificar_passageiro();

-- Transport activity is independent from login activity and administrative blocking.
CREATE VIEW admtaxi.uso_plano_passageiros AS
WITH viagens AS (
  SELECT f.identidade_transporte,c.finalizada_em,
    c.status='FINALIZADA' AND p.estado='DESEMBARCADO' AS transportado,
    c.status NOT IN ('FINALIZADA','CANCELADA','RECUSADA') AND p.estado NOT IN ('AUSENTE','CANCELADO') AS reservado
  FROM admtaxi.corrida_participacoes p
  JOIN admtaxi.funcionarios f ON f.empresa_id=p.empresa_id AND f.id=p.funcionario_id
  JOIN admtaxi.corridas c ON c.empresa_id=p.empresa_id AND c.id=p.corrida_id
  UNION ALL
  SELECT f.identidade_transporte,c.finalizada_em,
    c.status='FINALIZADA' AND c.desembarque_em IS NOT NULL,
    c.status NOT IN ('FINALIZADA','CANCELADA','RECUSADA')
  FROM admtaxi.corridas c JOIN admtaxi.funcionarios f ON f.empresa_id=c.empresa_id AND f.id=c.funcionario_id
  WHERE NOT EXISTS(SELECT 1 FROM admtaxi.corrida_participacoes p WHERE p.empresa_id=c.empresa_id AND p.corrida_id=c.id)
), uso AS (
 SELECT identidade_transporte,MAX(finalizada_em) FILTER(WHERE transportado) AS ultima_viagem,
   BOOL_OR(reservado) AS reservado FROM viagens GROUP BY identidade_transporte
)
SELECT identidade_transporte,ultima_viagem,
  COALESCE(ultima_viagem>CURRENT_TIMESTAMP-INTERVAL '62 days',FALSE) AS ativo_plano,
  reservado FROM uso;

CREATE FUNCTION admtaxi.validar_limite_passageiros(identidades TEXT[]) RETURNS VOID AS $$
DECLARE ocupados INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('plano_passageiros'),0);
  IF NOT EXISTS(SELECT unnest(identidades) EXCEPT
    SELECT identidade_transporte FROM admtaxi.uso_plano_passageiros WHERE ativo_plano OR reservado) THEN RETURN; END IF;
  SELECT COUNT(*) INTO ocupados FROM (
    SELECT identidade_transporte FROM admtaxi.uso_plano_passageiros WHERE ativo_plano OR reservado
    UNION SELECT unnest(identidades)
  ) pessoas;
  IF ocupados>200 THEN
    RAISE EXCEPTION USING ERRCODE='P2601', MESSAGE='Limite global de 200 passageiros atingido, incluindo reservas de corridas abertas. Aguarde uma vaga ou revise as corridas pendentes.';
  END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION admtaxi.reservar_vaga_passageiro() RETURNS TRIGGER AS $$
DECLARE identidade TEXT;
BEGIN
  IF TG_TABLE_NAME='corrida_participacoes' THEN
    IF TG_OP='UPDATE' AND NEW.funcionario_id=OLD.funcionario_id AND NEW.estado=OLD.estado THEN RETURN NEW; END IF;
    IF NEW.estado IN ('AUSENTE','CANCELADO','DESEMBARCADO') THEN RETURN NEW; END IF;
  ELSE
    IF TG_OP='UPDATE' AND NEW.funcionario_id=OLD.funcionario_id
      AND (OLD.status NOT IN ('CANCELADA','RECUSADA','FINALIZADA') OR NEW.status IN ('CANCELADA','RECUSADA','FINALIZADA')) THEN RETURN NEW; END IF;
  END IF;
  SELECT identidade_transporte INTO identidade FROM admtaxi.funcionarios WHERE empresa_id=NEW.empresa_id AND id=NEW.funcionario_id;
  IF identidade IS NOT NULL THEN PERFORM admtaxi.validar_limite_passageiros(ARRAY[identidade]); END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER corridas_limite_passageiros BEFORE INSERT OR UPDATE ON admtaxi.corridas
  FOR EACH ROW EXECUTE PROCEDURE admtaxi.reservar_vaga_passageiro();
CREATE TRIGGER participacoes_limite_passageiros BEFORE INSERT OR UPDATE ON admtaxi.corrida_participacoes
  FOR EACH ROW EXECUTE PROCEDURE admtaxi.reservar_vaga_passageiro();
