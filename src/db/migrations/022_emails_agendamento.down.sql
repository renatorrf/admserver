DO $$ BEGIN
  RAISE EXCEPTION 'Reversao automatica desabilitada para preservar o historico de emails de agendamento.';
END $$;
