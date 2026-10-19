DO $$ BEGIN RAISE EXCEPTION 'Rollback automatico bloqueado: contas de motorista compartilhadas possuem vinculos e historico.'; END $$;
