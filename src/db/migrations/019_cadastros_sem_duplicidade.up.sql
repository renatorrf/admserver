SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION admtaxi.normalizar_cadastro(valor TEXT, campo TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE STRICT AS $$
  SELECT NULLIF(CASE
    WHEN campo = 'telefone' THEN CASE
      WHEN length(digitos) IN (12, 13) AND left(digitos, 2) = '55' THEN substring(digitos FROM 3)
      ELSE digitos END
    WHEN campo = 'placa' THEN regexp_replace(upper(valor), '[^A-Z0-9]', '', 'g')
    WHEN campo = 'nome' THEN lower(btrim(regexp_replace(valor, '[[:space:]]+', ' ', 'g')))
    ELSE lower(btrim(valor)) END, '')
  FROM (SELECT regexp_replace(valor, '[^0-9]', '', 'g') AS digitos) normalized;
$$;

-- Do not merge, rename or remove existing registrations to force this migration through.
LOCK TABLE admtaxi.usuarios, admtaxi.prestadores, admtaxi.funcionarios, admtaxi.veiculos IN SHARE MODE;
DO $$
DECLARE rule RECORD; duplicates BIGINT;
BEGIN
  FOR rule IN SELECT * FROM (VALUES
    ('usuarios', 'nome'), ('usuarios', 'telefone'), ('usuarios', 'email'),
    ('prestadores', 'nome'), ('prestadores', 'telefone'), ('prestadores', 'email'),
    ('funcionarios', 'nome'), ('funcionarios', 'telefone'), ('funcionarios', 'email'),
    ('veiculos', 'placa')
  ) AS rules(tabela, campo)
  LOOP
    EXECUTE format('SELECT count(*) FROM (SELECT empresa_id, admtaxi.normalizar_cadastro(%I::text, %L)
      FROM admtaxi.%I WHERE admtaxi.normalizar_cadastro(%I::text, %L) IS NOT NULL
      GROUP BY empresa_id, admtaxi.normalizar_cadastro(%I::text, %L) HAVING count(*) > 1) duplicados',
      rule.campo, rule.campo, rule.tabela, rule.campo, rule.campo, rule.campo, rule.campo) INTO duplicates;
    IF duplicates > 0 THEN
      RAISE EXCEPTION 'Migration 019 bloqueada: % grupo(s) duplicado(s) em %.%. Regularize os cadastros antes de aplicar; nenhum dado foi alterado.',
        duplicates, rule.tabela, rule.campo;
    END IF;
    EXECUTE format('CREATE UNIQUE INDEX %I ON admtaxi.%I (empresa_id, admtaxi.normalizar_cadastro(%I::text, %L))',
      rule.tabela || '_empresa_' || rule.campo || '_normalizado_unico', rule.tabela, rule.campo, rule.campo);
  END LOOP;
END $$;
