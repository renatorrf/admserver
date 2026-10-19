DO $$ BEGIN
  RAISE EXCEPTION 'Rollback 014 bloqueado: preservar revogacoes de sessoes e recuperacoes de senha. Use correcao forward.';
END $$;
