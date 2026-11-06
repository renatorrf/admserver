-- Fails safely when dates are missing; never invent a date or delete a driver.
ALTER TABLE admtaxi.prestadores ALTER COLUMN validade_cnh SET NOT NULL;
