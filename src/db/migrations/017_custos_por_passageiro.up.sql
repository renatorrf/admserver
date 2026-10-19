ALTER TABLE admtaxi.corridas ADD COLUMN custos_individuais BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admtaxi.corrida_participacoes
  ADD COLUMN centro_custo_id UUID,
  ADD COLUMN valor NUMERIC(12,2) CHECK (valor >= 0);
UPDATE admtaxi.corrida_participacoes p SET centro_custo_id=c.centro_custo_id
  FROM admtaxi.corridas c WHERE c.empresa_id=p.empresa_id AND c.id=p.corrida_id;
ALTER TABLE admtaxi.corrida_participacoes ALTER COLUMN centro_custo_id SET NOT NULL;
ALTER TABLE admtaxi.corrida_participacoes ADD CONSTRAINT participacao_centro_empresa_fk
  FOREIGN KEY (empresa_id,centro_custo_id) REFERENCES admtaxi.centros_custo(empresa_id,id);
CREATE INDEX participacao_centro_idx ON admtaxi.corrida_participacoes(empresa_id,centro_custo_id,corrida_id);

-- Older backend revisions still insert the five original participation fields.
CREATE FUNCTION admtaxi.preparar_custo_participacao() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.centro_custo_id IS NULL THEN
    SELECT centro_custo_id INTO NEW.centro_custo_id FROM admtaxi.corridas WHERE empresa_id=NEW.empresa_id AND id=NEW.corrida_id;
  END IF;
  IF NEW.valor IS NULL AND EXISTS (SELECT 1 FROM admtaxi.corridas WHERE empresa_id=NEW.empresa_id AND id=NEW.corrida_id AND custos_individuais) THEN
    RAISE EXCEPTION 'Valores individuais devem ser preservados. Atualize o backend.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER preparar_custo_participacao BEFORE INSERT OR UPDATE ON admtaxi.corrida_participacoes
  FOR EACH ROW EXECUTE PROCEDURE admtaxi.preparar_custo_participacao();

-- Historical rides retain their original allocation; no retrospective splitting.
CREATE VIEW admtaxi.corrida_custos AS
  SELECT c.empresa_id,c.id AS corrida_id,p.funcionario_id,p.centro_custo_id,
    p.valor AS valor_estimado,CASE WHEN c.valor_final IS NOT NULL THEN p.valor ELSE NULL END AS valor_final
  FROM admtaxi.corridas c JOIN admtaxi.corrida_participacoes p ON p.empresa_id=c.empresa_id AND p.corrida_id=c.id
  WHERE c.custos_individuais
  UNION ALL
  SELECT c.empresa_id,c.id,c.funcionario_id,c.centro_custo_id,c.valor_estimado,c.valor_final
  FROM admtaxi.corridas c WHERE NOT c.custos_individuais;

CREATE TABLE admtaxi.faturamento_participacoes (
  empresa_id UUID NOT NULL,
  item_id UUID NOT NULL,
  funcionario_id UUID NOT NULL,
  centro_custo_id UUID NOT NULL,
  valor NUMERIC(12,2) NOT NULL CHECK (valor >= 0),
  PRIMARY KEY (empresa_id,item_id,funcionario_id),
  FOREIGN KEY (empresa_id,item_id) REFERENCES admtaxi.faturamento_itens(empresa_id,id),
  FOREIGN KEY (empresa_id,funcionario_id) REFERENCES admtaxi.funcionarios(empresa_id,id),
  FOREIGN KEY (empresa_id,centro_custo_id) REFERENCES admtaxi.centros_custo(empresa_id,id)
);
CREATE VIEW admtaxi.faturamento_custos AS
  SELECT empresa_id,item_id,funcionario_id,centro_custo_id,valor FROM admtaxi.faturamento_participacoes
  UNION ALL
  SELECT fi.empresa_id,fi.id,c.funcionario_id,c.centro_custo_id,fi.valor_faturado
  FROM admtaxi.faturamento_itens fi JOIN admtaxi.corridas c ON c.empresa_id=fi.empresa_id AND c.id=fi.corrida_id
  WHERE NOT EXISTS (SELECT 1 FROM admtaxi.faturamento_participacoes p WHERE p.empresa_id=fi.empresa_id AND p.item_id=fi.id);
