SET LOCAL lock_timeout = '10s';

ALTER TABLE admtaxi.empresas
  ADD COLUMN exige_aprovacao_gestor BOOLEAN NOT NULL DEFAULT TRUE;
