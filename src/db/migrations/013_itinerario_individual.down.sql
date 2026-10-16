DO $$ BEGIN
  RAISE EXCEPTION 'Rollback 013 bloqueado para preservar participacoes e auditoria. Use recuperacao forward ou backup validado conforme docs/revisao-geral/MIGRACAO_E_COMPATIBILIDADE.md.';
END $$;
