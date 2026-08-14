# Hierarquia operacional

```text
Empresa
└── Setores
    └── Centros de custo
        └── Funcionarios
            └── Corridas
```

## Isolamento

Toda entidade inclui `empresa_id`. As FKs compostas impedem que setor, centro, funcionario,
gerente ou corrida sejam vinculados entre empresas.

O gestor recebe escopo integral da empresa autenticada. O gerente recebe a intersecao entre:

- setores ativos registrados em `gerente_setores`;
- centros ativos registrados em `gerente_centros_custo`;
- setor ativo ao qual cada centro pertence.

O serviço `OperationalScopeService` resolve esse escopo no backend a cada requisicao. IDs ou listas
enviados pelo frontend funcionam apenas como filtros adicionais e nunca ampliam a autorizacao.

## Historico

O funcionario possui o centro atual. A corrida possui seu proprio `centro_custo_id`, preservando o
centro usado na solicitacao mesmo depois de uma transferencia do funcionario.

Centros anteriores a migration `009` permanecem temporariamente com `setor_id` nulo. Eles nao sao
oferecidos para novas corridas ate a regularizacao administrativa. Nenhum setor e inferido por nome.

## Tempo real e notificacoes

O Socket.IO permite entrada na sala de uma corrida somente depois que a consulta de snapshot passa
pelo mesmo escopo usado na API. Atualizacoes sao emitidas por sala de corrida, nao globalmente para
todos os gerentes da empresa.

Notificacoes de atualizacao sao destinadas ao funcionario, ao solicitante ainda autorizado e ao
prestador aplicavel. Outros gerentes nao recebem eventos implicitamente.

