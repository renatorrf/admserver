DO $$ BEGIN
  RAISE EXCEPTION 'Rollback 015 bloqueado para preservar emails e revogacoes master. Use correcao forward.';
END $$;
