# Migrations

As migrations sao SQL incremental, executadas em ordem numerica e registradas em
`admtaxi.schema_migrations`. O runner valida o checksum das migrations ja aplicadas e usa um
advisory lock para impedir duas execucoes simultaneas.

## Comandos

```powershell
npm run migrate:status
npm run migrate:validate
npm run migrate
```

Os arquivos `*.down.sql` tornam cada passo reversivel, mas o rollback e destrutivo e permanece
bloqueado por padrao. Para uma reversao deliberada em ambiente controlado:

```powershell
$env:ALLOW_DESTRUCTIVE_MIGRATION='true'
npm run migrate:down
```

Nunca execute rollback no banco de producao sem backup verificado, janela de manutencao e
aprovacao explicita. O seed de desenvolvimento e separado e nunca e executado pelas migrations.

## Regras

- Nao altere uma migration ja aplicada; crie outra migration incremental.
- Nao inclua credenciais ou dados de ambiente nos arquivos SQL.
- Toda referencia entre entidades de negocio inclui `empresa_id` para reforcar o isolamento.
- Valores monetarios usam `NUMERIC(12, 2)` e datas de negocio usam `TIMESTAMPTZ`.
