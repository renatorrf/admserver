DO $$ BEGIN
  RAISE EXCEPTION 'Rollback automatico indisponivel: preserve os vinculos e as credenciais dos funcionarios. Prepare uma migracao de reversao auditada.';
END $$;
