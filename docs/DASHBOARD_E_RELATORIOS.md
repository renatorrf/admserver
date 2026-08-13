# Dashboard e relatorios

## Acesso e escopo

Os endpoints de dashboard e relatorios aceitam somente os perfis `GERENTE` e `GESTOR`.
O `GESTOR` consulta toda a empresa autenticada. O `GERENTE` consulta apenas as corridas dos
centros de custo vinculados ao seu usuario. Filtros fora desse escopo retornam `403`.

## Endpoints

- `GET /api/v1/dashboard`: indicadores, custos por centro e prestador, evolucao de 12 meses,
  corridas ativas com a ultima localizacao e proximas corridas agendadas.
- `GET /api/v1/relatorios/corridas`: relatorio paginado, resumo financeiro e agrupamentos.
- `GET /api/v1/relatorios/corridas.csv`: exportacao dos mesmos filtros, limitada a 10.000 linhas.
- `GET /api/v1/operacao/prestadores`: opcoes de prestador para filtros.
- `GET /api/v1/operacao/solicitantes`: opcoes de solicitante conforme o perfil.

Os filtros disponiveis sao `inicio`, `fim`, `status`, `centroCustoId`, `funcionarioId`,
`prestadorId` e `solicitanteUsuarioId`. A listagem tambem aceita `pagina` e `limite`.

## CSV

O arquivo usa UTF-8 com BOM e ponto e virgula como delimitador para interoperabilidade com
planilhas em portugues. Campos sao escapados conforme CSV e valores iniciados por caracteres de
formula sao neutralizados para evitar execucao ao abrir o arquivo.

Valores monetarios continuam representados como decimal em texto na API e no CSV. Nenhuma
conversao para ponto flutuante ocorre na camada de persistencia.
