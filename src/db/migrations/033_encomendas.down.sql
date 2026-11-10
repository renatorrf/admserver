DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM admtaxi.corridas WHERE encomenda IS NOT NULL)
     OR EXISTS (SELECT 1 FROM admtaxi.requisicoes_viagem WHERE dados ? 'encomenda') THEN
    RAISE EXCEPTION 'O rollback apagaria encomendas registradas.';
  END IF;
END $$;

DROP VIEW admtaxi.corrida_custos;
ALTER VIEW admtaxi.corrida_custos_viagens RENAME TO corrida_custos;
ALTER TABLE admtaxi.corridas
  DROP CONSTRAINT corridas_modalidade_valida,
  DROP COLUMN encomenda,
  ALTER COLUMN funcionario_id SET NOT NULL,
  ADD CONSTRAINT corridas_quantidade_passageiros_valida CHECK (quantidade_passageiros BETWEEN 1 AND 99);
