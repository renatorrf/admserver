DO $$ BEGIN
  RAISE EXCEPTION 'Rollback automatico bloqueado: contas compartilhadas e senhas exigem migracao de retorno planejada.';
END $$;
