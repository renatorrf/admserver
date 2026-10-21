ALTER TABLE admtaxi.empresas ADD COLUMN modo_cobranca TEXT NOT NULL DEFAULT 'MANUAL'
  CHECK (modo_cobranca IN ('MANUAL','MENSAL_FIXO'));
ALTER TABLE admtaxi.prestadores ADD COLUMN valor_mensal_fixo NUMERIC(12,2)
  CHECK (valor_mensal_fixo >= 0);
ALTER TABLE admtaxi.corridas ADD COLUMN modo_cobranca TEXT NOT NULL DEFAULT 'MANUAL'
  CHECK (modo_cobranca IN ('MANUAL','MENSAL_FIXO'));
-- Replace only the validation rule, preserving every historical row.
ALTER TABLE admtaxi.corridas DROP CONSTRAINT corridas_finalizacao_valida;
ALTER TABLE admtaxi.corridas ADD CONSTRAINT corridas_finalizacao_valida CHECK (
  status <> 'FINALIZADA' OR (finalizada_em IS NOT NULL AND
    ((modo_cobranca='MANUAL' AND valor_final IS NOT NULL) OR (modo_cobranca='MENSAL_FIXO' AND valor_final IS NULL)))
);
ALTER TABLE admtaxi.faturamentos ADD COLUMN modo_cobranca TEXT NOT NULL DEFAULT 'MANUAL'
  CHECK (modo_cobranca IN ('MANUAL','MENSAL_FIXO'));
CREATE UNIQUE INDEX faturamento_mensal_competencia_unica
  ON admtaxi.faturamentos(empresa_id,prestador_id,periodo_inicio)
  WHERE modo_cobranca='MENSAL_FIXO' AND status <> 'CANCELADO';
-- Capture the company policy once; subsequent company changes preserve ride history.
CREATE FUNCTION admtaxi.definir_cobranca_corrida() RETURNS trigger AS $$
BEGIN
  SELECT modo_cobranca INTO NEW.modo_cobranca FROM admtaxi.empresas WHERE id=NEW.empresa_id;
  IF NEW.modo_cobranca='MENSAL_FIXO' THEN NEW.valor_estimado := NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER definir_cobranca_corrida BEFORE INSERT ON admtaxi.corridas
  FOR EACH ROW EXECUTE PROCEDURE admtaxi.definir_cobranca_corrida();

-- Existing reports consume this view. Monthly values appear only after closing,
-- from the immutable allocation, never from an invented individual ride price.
CREATE OR REPLACE VIEW admtaxi.corrida_custos AS
  SELECT c.empresa_id,c.id AS corrida_id,p.funcionario_id,p.centro_custo_id,
    p.valor AS valor_estimado,CASE WHEN c.valor_final IS NOT NULL THEN p.valor ELSE NULL END AS valor_final
  FROM admtaxi.corridas c JOIN admtaxi.corrida_participacoes p ON p.empresa_id=c.empresa_id AND p.corrida_id=c.id
  WHERE c.custos_individuais AND c.modo_cobranca='MANUAL'
  UNION ALL
  SELECT c.empresa_id,c.id,c.funcionario_id,c.centro_custo_id,c.valor_estimado,c.valor_final
  FROM admtaxi.corridas c WHERE NOT c.custos_individuais AND c.modo_cobranca='MANUAL'
  UNION ALL
  SELECT c.empresa_id,c.id,p.funcionario_id,p.centro_custo_id,NULL::numeric(12,2),fp.valor
  FROM admtaxi.corridas c JOIN admtaxi.corrida_participacoes p ON p.empresa_id=c.empresa_id AND p.corrida_id=c.id
  LEFT JOIN admtaxi.faturamento_itens fi ON fi.empresa_id=c.empresa_id AND fi.corrida_id=c.id AND fi.ativo
  LEFT JOIN admtaxi.faturamento_participacoes fp ON fp.empresa_id=fi.empresa_id AND fp.item_id=fi.id AND fp.funcionario_id=p.funcionario_id
  WHERE c.modo_cobranca='MENSAL_FIXO' AND p.estado NOT IN ('AUSENTE','CANCELADO');
