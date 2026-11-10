# Web Push VAPID

O ADM-Taxi usa Web Push padrao com `PushManager`, Service Worker e `web-push`. Firebase pode hospedar
o frontend, mas o FCM do APK Android e um fluxo separado do Web Push do PWA.

## Configuracao

Gere o par uma unica vez em um terminal administrativo:

```powershell
npm run push:vapid:generate
```

Armazene a chave privada somente no gerenciador de segredos e configure as variaveis listadas em
`.env.example`. O backend rejeita configuracao VAPID parcial. Nao gere chaves no startup e nao troque
o par enquanto existirem inscricoes; uma troca exige reinscricao de todos os dispositivos.

## Troca de dominio do PWA

- Use `PUSH_APP_URL=https://admbrasil-taxi.web.app/` e mantenha `PUSH_DEFAULT_OPEN_URL=/app` e
  `PUSH_RIDE_OPEN_URL=/app/corridas` relativos. Configure a origem nova em `APP_ORIGINS`.
- O worker no dominio novo exibe **ADM BRASIL - TAXI** e o resumo em PT-BR. Links historicos
  para `admtaxi-2bcf2.web.app` e seu alias Firebase abrem a mesma rota no dominio novo.
- A origem que o sistema mostra no aviso pertence ao registro do worker. Alterar a URL de
  abertura, CORS ou o nome do manifesto nao migra inscricoes ja criadas no dominio antigo.
- No aparelho afetado, entre em `https://admbrasil-taxi.web.app`, ative as notificacoes no
  perfil e teste o recebimento. Depois, remova o PWA antigo e bloqueie as notificacoes somente
  do dominio antigo nas permissoes do navegador. Nao revogue inscricoes em massa nem troque o VAPID.

## Fluxo e diagnostico

1. O perfil solicita `GET /api/v1/push/public-key` e, por acao do usuario, pede permissao.
2. O frontend aguarda `navigator.serviceWorker.ready`, cria a inscricao e envia `endpoint`, `p256dh`
   e `auth` para `POST /api/v1/push/subscriptions`.
3. O backend define empresa e usuario pela sessao, permite varios dispositivos e nunca devolve as
   chaves ou o endpoint completo.
4. Cada evento e cada dispositivo possuem tentativa idempotente. `404/410` inativam a inscricao;
   `429/5xx` recebem uma unica nova tentativa controlada.
5. Falhas ocorrem depois do commit e nunca desfazem uma operacao de corrida.

O gestor consulta `GET /api/v1/push/diagnostics` e envia um teste por dispositivo. Verifique, nesta
ordem: variaveis e par VAPID, HTTPS, worker ativo, permissao, inscricao persistida, vinculo ativo,
regiao do prestador, tentativa individual, recepcao e clique. URLs de abertura externas sao recusadas.

No iOS, Web Push exige versao compativel, PWA instalada na Tela de Inicio, HTTPS e permissao pedida
apos uma acao do usuario. Homologue com o PWA fechado ou em segundo plano. No Android, homologue o
PWA instalado e o Chrome em primeiro e segundo plano. O worker preserva a rota; se a sessao expirou,
o guard envia ao login e retorna para a corrida depois da autenticacao.

## Avisos de requisicoes de viagem

Depois de aplicar a migracao 031, e-mail e app usam a mesma regra de destinatarios:

| Etapa | Destinatarios |
| --- | --- |
| Pendente | Gestores marcados e funcionarios cadastrados |
| Autorizada | Gestores marcados, supervisor solicitante, portaria e funcionarios cadastrados |
| Recusada | Gestores marcados, supervisor solicitante e funcionarios cadastrados |
| Conferida e solicitada | Gestores marcados, supervisor solicitante, portaria e passageiros agora cadastrados |
| Finalizada ou cancelada | Gestores marcados, supervisor solicitante, portaria e passageiros da corrida |

A opcao de avisos pertence ao vinculo ativo de gestor na unidade. O padrao e marcado para preservar
o comportamento dos cadastros existentes. Desmarcar nao altera permissoes.

E-mails exigem endereco valido; cada passageiro recebe apenas seu proprio itinerario. Quando a
portaria cria um acesso com e-mail, o convite de primeiro acesso e separado do aviso de viagem.
O app registra o aviso para a conta ativa mesmo sem inscricao de push; a entrega em segundo plano
exige uma inscricao valida. Avisos nao incluem enderecos na tela bloqueada.

O registro dos avisos e atomico com a transicao. A entrega usa a fila SMTP e o Web Push existentes,
sem reenviar o aviso de corrida solicitada/concluida pela rota antiga. As mudancas intermediarias
da corrida mantem os avisos do app; nao geram um e-mail para cada parada.

## Historico do transporte

As notificacoes nao chegavam de forma confiavel porque o sistema persistia tokens FCM e dependia de
Firebase Admin/Messaging, enquanto o PWA solicitado deveria usar inscricoes Web Push VAPID nativas.
O fluxo anterior tambem nao oferecia tentativa individual VAPID nem diagnostico completo por usuario.
A migration `011_web_push_vapid` cria a persistencia nova; as tabelas legadas permanecem preservadas.
