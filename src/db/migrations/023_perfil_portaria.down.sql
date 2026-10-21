DO $$ BEGIN
  RAISE EXCEPTION 'Rollback 023 bloqueado: remover o perfil PORTARIA exige revisao dos usuarios existentes.';
END $$;
