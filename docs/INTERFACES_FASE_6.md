# Interfaces por perfil - Fase 6

## Rotas do aplicativo

| Rota | Perfis | Funcao |
| --- | --- | --- |
| `/login` | Publica | Login por codigo da empresa, e-mail e senha |
| `/app/corridas` | Todos | Corridas em andamento, historico e busca local |
| `/app/corridas/nova` | GERENTE, GESTOR | Solicitacao imediata ou agendada |
| `/app/corridas/:id` | Todos, conforme escopo | Detalhes, historico e proxima acao permitida |
| `/acompanhamento/:id` | Todos, conforme escopo | Mapa e atualizacao em tempo real |
| `/app/cadastros` | GESTOR | Usuarios, prestadores, veiculos, centros, funcionarios e auditoria |
| `/app/perfil` | Todos | Identidade da sessao e logout |

O shell e responsivo: menu lateral persistente em desktop e menu sobreposto em telas menores. Os
guards validam autenticacao e perfil, e o backend continua sendo a autoridade final de acesso.

## Prestador

- consulta corridas disponiveis, ofertadas, ativas e historicas;
- altera sua disponibilidade, exceto quando existe corrida ativa;
- seleciona um veiculo proprio ativo para aceitar ou reivindicar uma corrida;
- aceita ou recusa oferta, inicia deslocamento, confirma chegada, embarque e desembarque;
- finaliza somente depois do desembarque, informando valor final e observacao opcional;
- abre o mapa e controla explicitamente o compartilhamento de localizacao.

## Gerente

- consulta somente corridas dos centros de custo autorizados;
- solicita corrida para funcionario ativo de um centro autorizado;
- usa endereco e coordenadas padrao do funcionario quando aplicaveis;
- cria corrida imediata ou agendada, com passageiros, trajeto, valor estimado e observacao;
- acompanha status, prestador, veiculo, eventos e mapa;
- cancela com motivo apenas corridas solicitadas ou ofertadas.

## Gestor

- consulta todas as corridas da empresa;
- atribui ou altera prestador e veiculo em corridas solicitadas ou ofertadas;
- reabre corrida recusada e cancela ate o estado `ACEITA`;
- cria, edita, inativa e reativa usuarios, prestadores, veiculos, centros de custo e funcionarios;
- vincula centros autorizados a usuarios `GERENTE`;
- consulta a trilha de auditoria da empresa.

## Endpoints de apoio

- `GET /api/v1/operacao/centros-custo`
- `GET /api/v1/operacao/funcionarios?centroCustoId=:id`
- `GET /api/v1/operacao/meu-prestador`
- `GET /api/v1/operacao/meus-veiculos`

Essas consultas retornam apenas registros ativos e aplicam o tenant e o escopo do perfil no
backend. Nenhum `empresaId` e aceito do cliente.

## Sessao e falhas

Access token, refresh token e usuario ficam em `sessionStorage`. O interceptor adiciona o bearer
token, coordena uma unica renovacao quando recebe `401` e repete a requisicao original. Falha na
renovacao limpa a sessao. O logout tenta revogar o refresh token e sempre remove os dados locais.

As telas possuem carregamento, vazio, erro recuperavel e confirmacao para acoes destrutivas ou de
mudanca de estado. Datas usam `pt-BR`, valores usam BRL e os textos visiveis estao em portugues.

## Dados e validacao

Esta fase nao exigiu migration. O schema existente ja continha as relacoes necessarias. Nenhum seed
ou dado de negocio foi aplicado ao banco remoto; o primeiro login continua dependendo de
provisionamento controlado.
