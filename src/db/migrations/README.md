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

## Regularizacao da migration 009

A migration `009_setores_escopo_gerente` nao associa centros existentes automaticamente. Depois da
aplicacao autorizada, o gestor deve:

1. cadastrar os setores;
2. vincular os setores aos gerentes;
3. definir `setor_id` nos centros legados;
4. revisar os centros autorizados de cada gerente.

Consulta somente leitura para localizar pendencias:

```sql
SELECT e.codigo_acesso, c.id, c.codigo, c.nome
FROM admtaxi.centros_custo c
JOIN admtaxi.empresas e ON e.id = c.empresa_id
WHERE c.setor_id IS NULL
ORDER BY e.codigo_acesso, c.codigo;
```

Enquanto um centro permanecer sem setor, ele e preservado para o historico, mas nao e oferecido em
novas solicitacoes de corrida.
