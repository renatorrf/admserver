# Faturamento

O modulo financeiro usa exclusivamente valores `NUMERIC` do PostgreSQL. `valor_estimado` nunca
entra nos totais realizados. O fechamento e administrativo e exclusivo do `GESTOR`; o prestador
consulta somente os fechamentos vinculados ao proprio cadastro.

## Fluxo

1. `GET /api/v1/faturamentos/resumo` agrega o periodo por prestador, setor, centro e funcionario.
2. `GET /api/v1/faturamentos/elegiveis` seleciona corridas `FINALIZADA`, com `valor_final`, do
   prestador e tenant informados, sem item ativo em outro fechamento.
3. `POST /api/v1/faturamentos` bloqueia concorrencia por empresa, relê e trava as corridas, exige
   classificacao de todas como selecionadas ou excluidas com motivo e fecha em uma transacao.
4. O item preserva `valor_faturado`; alteracoes posteriores na corrida nao alteram esse valor.
5. `POST /api/v1/faturamentos/:id/cancelar` marca o fechamento como `CANCELADO`, preserva os itens,
   inativa a participacao e libera as corridas para novo fechamento.

Correcoes usam `PATCH /api/v1/faturamentos/corridas/:id/valor-final`, exigem justificativa e geram
historico, evento e auditoria. Uma corrida com item ativo deve ter o fechamento cancelado antes.
CSV esta disponivel em `GET /api/v1/faturamentos/:id/csv`. PDF nao foi criado porque o projeto nao
possui infraestrutura existente de geracao de PDF.

## Integridade

- Todos os filtros partem do `empresa_id` do JWT.
- O gerente recebe `403` e nao pode fechar nem consultar faturamento.
- O indice parcial de `faturamento_itens` impede duas participacoes ativas da mesma corrida.
- Fechamentos e cancelamentos sao logicos e auditados; nao existe exclusao financeira fisica.
- A migration `010_faturamento_valor_final` deve ser aplicada antes de publicar o modulo.
