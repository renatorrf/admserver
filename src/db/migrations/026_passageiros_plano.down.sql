DO $$ BEGIN
  RAISE EXCEPTION 'Rollback automatico indisponivel: preserve os passageiros avulsos e o historico. Prepare uma migracao corretiva.';
END $$;
