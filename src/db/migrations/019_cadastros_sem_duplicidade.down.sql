DO $$ BEGIN
  RAISE EXCEPTION 'Rollback automatico desabilitado: preserve a protecao contra cadastros duplicados.';
END $$;
