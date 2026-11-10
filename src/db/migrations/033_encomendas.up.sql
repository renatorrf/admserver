SET LOCAL lock_timeout = '10s';

ALTER TABLE admtaxi.corridas
  ADD COLUMN encomenda JSONB,
  ALTER COLUMN funcionario_id DROP NOT NULL,
  DROP CONSTRAINT corridas_quantidade_passageiros_valida,
  ADD CONSTRAINT corridas_modalidade_valida CHECK (
    (encomenda IS NULL AND funcionario_id IS NOT NULL AND quantidade_passageiros BETWEEN 1 AND 99)
    OR (encomenda IS NOT NULL AND jsonb_typeof(encomenda) = 'object'
        AND COALESCE(encomenda->>'tipo' IN ('ENVIO','RETIRADA'), FALSE)
        AND COALESCE(length(trim(encomenda->>'descricao')) BETWEEN 3 AND 500, FALSE)
        AND funcionario_id IS NULL AND quantidade_passageiros = 0
        AND NOT custos_individuais AND itinerario_versao = 0
        AND (status <> 'FINALIZADA' OR desembarque_em IS NOT NULL)
        AND origem_latitude IS NOT NULL AND destino_latitude IS NOT NULL)
  );

ALTER VIEW admtaxi.corrida_custos RENAME TO corrida_custos_viagens;
CREATE VIEW admtaxi.corrida_custos AS
  SELECT * FROM admtaxi.corrida_custos_viagens
  UNION ALL
  SELECT c.empresa_id, c.id AS corrida_id, NULL::uuid AS funcionario_id, c.centro_custo_id,
    NULL::numeric(12,2) AS valor_estimado, fi.valor_faturado AS valor_final
  FROM admtaxi.corridas c LEFT JOIN admtaxi.faturamento_itens fi
    ON fi.empresa_id=c.empresa_id AND fi.corrida_id=c.id AND fi.ativo
  WHERE c.encomenda IS NOT NULL AND c.modo_cobranca='MENSAL_FIXO';
