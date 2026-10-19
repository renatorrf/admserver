ALTER TABLE admtaxi.empresas
  ADD COLUMN endereco VARCHAR(500),
  ADD COLUMN endereco_latitude NUMERIC(10,7),
  ADD COLUMN endereco_longitude NUMERIC(10,7),
  ADD CONSTRAINT empresas_endereco_completo CHECK (
    (endereco IS NULL AND endereco_latitude IS NULL AND endereco_longitude IS NULL)
    OR (endereco IS NOT NULL AND length(trim(endereco)) >= 3
      AND endereco_latitude IS NOT NULL AND endereco_latitude BETWEEN -90 AND 90
      AND endereco_longitude IS NOT NULL AND endereco_longitude BETWEEN -180 AND 180)
  );
