DROP TRIGGER dispositivos_push_definir_atualizado_em ON admtaxi.dispositivos_push;
DROP TABLE admtaxi.notificacoes_push;
DROP TABLE admtaxi.dispositivos_push;

ALTER TABLE admtaxi.empresas
  DROP CONSTRAINT empresas_coordenadas_padrao_completas,
  DROP CONSTRAINT empresas_longitude_padrao_valida,
  DROP CONSTRAINT empresas_latitude_padrao_valida,
  DROP CONSTRAINT empresas_estado_padrao_formato,
  DROP COLUMN longitude_padrao,
  DROP COLUMN latitude_padrao,
  DROP COLUMN estado_padrao,
  DROP COLUMN cidade_padrao;
