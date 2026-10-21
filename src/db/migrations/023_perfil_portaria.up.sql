-- transaction: none
-- Preserve os perfis e vinculos existentes; GERENTE continua sendo o identificador de Supervisor.
ALTER TYPE admtaxi.perfil_usuario ADD VALUE IF NOT EXISTS 'PORTARIA';
