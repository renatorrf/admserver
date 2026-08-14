# Web Push VAPID

O ADM-Taxi usa Web Push padrao com `PushManager`, Service Worker e `web-push`. Firebase pode hospedar
o frontend, mas Firebase Messaging, FCM, tokens FCM e o worker de Messaging nao fazem parte do fluxo.

## Configuracao

Gere o par uma unica vez em um terminal administrativo:

```powershell
npm run push:vapid:generate
```

Armazene a chave privada somente no gerenciador de segredos e configure as variaveis listadas em
`.env.example`. O backend rejeita configuracao VAPID parcial. Nao gere chaves no startup e nao troque
o par enquanto existirem inscricoes; uma troca exige reinscricao de todos os dispositivos.

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

## Causas anteriores

As notificacoes nao chegavam de forma confiavel porque o sistema persistia tokens FCM e dependia de
Firebase Admin/Messaging, enquanto o PWA solicitado deveria usar inscricoes Web Push VAPID nativas.
O fluxo anterior tambem nao oferecia tentativa individual VAPID nem diagnostico completo por usuario.
A migration `011_web_push_vapid` cria a persistencia nova; as tabelas legadas permanecem preservadas.
