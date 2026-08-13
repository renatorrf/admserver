# Geolocalizacao e tempo real

## Limites de coleta

A posicao so e aceita quando todas estas condicoes sao verdadeiras:

- o access token pertence a um usuario `PRESTADOR` ativo;
- o usuario esta vinculado ao prestador atribuido a corrida;
- a corrida pertence a mesma empresa do token;
- o status e `ACEITA`, `EM_DESLOCAMENTO`, `AGUARDANDO_PASSAGEIRO` ou `EM_CORRIDA`.

O backend bloqueia a leitura da corrida com `FOR SHARE` na mesma transacao do `INSERT`. Isso evita
que uma finalizacao ou cancelamento concorra com uma nova posicao. Coordenadas sao validadas com
Zod e o horario persistido e o horario do servidor.

Nao existe coleta oculta. No frontend, o prestador liga o controle **Compartilhar localizacao**,
o navegador solicita permissao e um `watchPosition` envia no maximo uma posicao a cada 10 segundos.
O acompanhamento para ao desligar o controle, sair da tela, negar a permissao, finalizar ou cancelar
a corrida.

## API HTTP

- `POST /api/v1/corridas/:id/localizacoes`: fallback autenticado para envio pelo prestador.
- `GET /api/v1/corridas/:id/localizacoes`: historico paginado conforme o escopo da corrida.

O POST possui limite de 30 requisicoes por minuto. O limite global da API continua aplicavel.

## Socket.IO

Endpoint: `/socket.io`. O cliente envia o access token em `handshake.auth.token`. A conexao e
encerrada quando o JWT expira, e cada operacao volta a validar o token.

Eventos enviados pelo cliente:

| Evento | Payload | Resultado |
| --- | --- | --- |
| `corrida:acompanhar` | `{ corridaId }` | Entra na sala e recebe corrida/localizacao atual |
| `corrida:parar-acompanhamento` | `{ corridaId }` | Sai da sala |
| `localizacao:enviar` | `{ corridaId, latitude, longitude, ... }` | Persiste e publica a posicao |

Eventos enviados pelo servidor:

| Evento | Conteudo |
| --- | --- |
| `corrida:atualizada` | Corrida apos uma operacao confirmada no banco |
| `localizacao:atualizada` | Posicao apos persistencia confirmada |

As salas usam empresa e corrida no identificador interno. Antes de entrar, o backend aplica o mesmo
escopo da API REST: gestor ve a empresa, gerente ve centros autorizados e prestador ve suas corridas.
Salas de corridas finalizadas ou canceladas sao encerradas apos o ultimo evento.

## Mapa

O frontend usa Leaflet com tiles do OpenStreetMap. A rota `/acompanhamento/:id` mostra embarque,
destino, historico recebido pela API e posicao atual recebida por Socket.IO. O token permanece em
`sessionStorage`, e login, interceptor HTTP e navegacao ate a corrida estao integrados ao shell.

Tiles dependem de acesso a internet. Para producao com volume relevante, deve ser definido um
provedor de tiles com termos e capacidade adequados; nao foi adicionado servico pago nesta fase.

## PWA e iOS

Navegadores podem suspender JavaScript e geolocalizacao quando a PWA fica em segundo plano. O iOS
e especialmente restritivo e nao garante atualizacoes continuas com a tela bloqueada ou o Safari/PWA
fora de foco. Portanto, esta versao serve para acompanhamento com o app aberto e visivel.

Uma futura versao Capacitor nativa deve substituir apenas o provedor de localizacao por um plugin
de background geolocation, com consentimento explicito, indicador permanente e configuracao de
permissoes das lojas. O contrato de envio ao backend pode ser mantido.

## Retencao

As localizacoes permanecem armazenadas ate uma politica formal ser aprovada. Nao existe expurgo
automatico nesta fase. Antes de producao, definir prazo, base legal, responsavel, rotina auditavel
de exclusao e necessidade de agregacao para relatorios.
