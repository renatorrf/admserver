DROP TABLE admtaxi.rastreios_passageiro;
DROP TABLE admtaxi.whatsapp_cadastros;
DROP TRIGGER registrar_app_instalado ON admtaxi.dispositivos_usuario;
DROP FUNCTION admtaxi.registrar_app_instalado();
ALTER TABLE admtaxi.usuarios DROP COLUMN whatsapp_autorizado_em;
ALTER TABLE admtaxi.usuarios DROP COLUMN app_instalado_em;
