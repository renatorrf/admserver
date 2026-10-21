# Requisicoes de viagem

## Fluxo

1. Supervisor (`GERENTE` no contrato existente) cria requisicao com funcionarios do seu escopo. Origem, destino e valor podem ficar pendentes. Nao e criada uma corrida nesta etapa.
2. Gestor autoriza ou recusa, com motivo obrigatorio na recusa. Requisicao criada pelo proprio gestor nasce autorizada.
3. Somente Portaria confere e solicita. Deve completar todos os enderecos com coordenadas e, no modo manual, todos os valores. Nao pode trocar funcionarios, enderecos ou valores ja informados na requisicao autorizada. Para isso, e necessaria nova requisicao.
4. A corrida e criada e disponibilizada aos prestadores apenas na conferencia. Agendamentos continuam respeitando o aceite a partir de uma hora antes.
5. Finalizacao pelo prestador enfileira o aviso de conclusao na mesma transacao.

Empresas, centros e funcionarios sao validados pelo backend; empresa nunca vem do corpo da requisicao. O supervisor consulta apenas as proprias requisicoes. Gestor e Portaria consultam as da empresa autenticada. Prestadores e funcionarios nao acessam este modulo administrativo.

## API

- `GET /api/v1/requisicoes?offset=0`: paginas de 50 registros, mais recentes primeiro.
- `GET /api/v1/requisicoes/:id`: requisicao acessivel no escopo autenticado.
- `POST /api/v1/requisicoes`: `chave` UUID, `tipo`, `agendadaPara`, `observacao`, `participantes`.
- Participante: `funcionarioId`, `origem` e `destino` opcionais (`descricao`, `latitude`, `longitude`), `valor` opcional no modo manual. Maximo de 16 participantes, permitindo os 32 pontos do itinerario existente.
- `POST /api/v1/requisicoes/:id/decisao`: `{ autorizar, motivo? }`, somente Gestor.
- `POST /api/v1/requisicoes/:id/solicitar`: `{ participantes }`, somente Portaria. Completa dados pendentes, preserva os autorizados e deriva os centros de custo do cadastro.
- `POST /api/v1/corridas` passa a recusar criacao direta com uma mensagem sobre o novo fluxo. Corridas ja existentes continuam operacionais.

Criacao possui chave e hash de idempotencia. Decisao e conferencia usam bloqueio transacional. Repetir a conferencia nao cria outra corrida, inclusive com duas portarias concorrentes. Erro na gravacao do aviso/auditoria reverte a transacao; falha no envio SMTP nao reverte a viagem.

## E-mails

Os eventos `PENDENTE`, `AUTORIZADA`, `REJEITADA`, `SOLICITADA` e `FINALIZADA` geram registros em `admtaxi.emails_viagem`. Gestores ativos, portarias ativas e solicitante ativo recebem resumo administrativo; cada funcionario recebe somente seus proprios enderecos. Enderecos de e-mail invalidos ou ausentes nao recebem aviso. Nao ha envio compartilhado por CC.

A fila usa o SMTP existente: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`. A configuracao atual tambem exige `PASSWORD_RESET_URL` valido. Nenhuma credencial foi alterada. SMTP ausente preserva a fila; configuracao parcial e rejeitada na inicializacao.

O worker utiliza reservas com prazo de dois minutos, `SKIP LOCKED`, cinco tentativas com espera exponencial e identificador de mensagem estavel. A unicidade no banco evita enfileiramento repetido; SMTP nao oferece garantia absoluta de entrega exatamente uma vez em caso de falha apos o servidor aceitar a mensagem.

O servidor processa a fila a cada 30 segundos. Em Cloud Run com CPU restrita fora das requisicoes, configure CPU sempre disponivel ou execute o job existente `npm run email:process` periodicamente, apos a build. `src/process-scheduled-emails.ts` agora processa as duas filas. Monitorar `status`, `tentativas` e `ultimo_erro`; `FALHOU` requer verificacao operacional. Nunca executar testes de envio com enderecos reais sem autorizacao.

## Publicacao e validacao

Migration `025_requisicoes_viagem` e aditiva: cria requisicoes e fila sem alterar corridas historicas. Publicar backend e frontend juntos, pois o frontend antigo nao deve mais criar corridas diretamente. Nao houve deploy automatico.

Testes: schemas, permissoes HTTP, PostgreSQL local isolado, conferencia concorrente, escopo/tenant, recusa, finalizacao real pelo servico, privacidade dos e-mails e repeticao de SMTP com transporte simulado. O frontend inclui testes de rascunho, rotas por perfil e cenarios Playwright mobile/desktop. A abertura real do Google Maps no aparelho e a entrega SMTP no ambiente publicado precisam de homologacao.

Na tela do motorista, Google Maps recebe apenas a proxima parada da sequencia otimizada; o aplicativo continua responsavel por chegada, embarque, ausencia e desembarque. Documentacao: https://developers.google.com/maps/documentation/urls/get-started
