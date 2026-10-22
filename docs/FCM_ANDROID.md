# Push Android do motorista

## Configuracao

- Aplicativo: `com.admbrasil.taxi`, Firebase `admbrasil-taxi`.
- Aplicar `027_fcm_android` antes de iniciar o backend atualizado.
- Definir `FCM_PROJECT_ID=admbrasil-taxi` no backend.
- Usar Application Default Credentials da identidade do Cloud Run. Nao incluir
  chave de servico no APK, no repositorio nem em variavel do frontend.
- Habilitar a API FCM e conceder a identidade do Cloud Run a permissao
  `cloudmessaging.messages.create` no projeto Firebase de destino.
- Publicar o backend e distribuir o novo APK. Publicar so o PWA nao atualiza APKs.

## Entrega e seguranca

O plugin NativePush registra o token depois do login PRESTADOR e da troca da
senha temporaria. Usa canal `adm_corridas_v1` com importancia alta e solicita
POST_NOTIFICATIONS no Android 13+. Minha conta permite ativar/desativar.

WorkManager renova o registro apos rotacao do token e falhas de rede. A sessao
e lida do armazenamento criptografado existente. O token do dispositivo nao
concede acesso a nenhuma corrida. O backend resolve os vinculos ativos do
motorista nas empresas e confere a versao de sua credencial antes do envio.

A mensagem e data-only, de alta prioridade, com identificadores, titulo e resumo
genericos, sem nomes, telefones, enderecos ou coordenadas. FirebaseMessagingService
exibe a notificacao mesmo com a WebView suspensa. Em primeiro plano, permanece o
banner do inbox existente, sem alerta de sistema duplicado. O toque abre a corrida
pela navegacao autenticada. Logout/troca de conta invalida o vinculo e limpa os
alertas locais; mensagens atrasadas desse vinculo sao descartadas.

O trigger de notificacoes grava a fila na mesma transacao da notificacao. Workers
usam SKIP LOCKED para evitar processamento concorrente. Tokens invalidos sao
inativados. Falhas transitorias sao tentadas ate cinco vezes, com espera crescente,
dentro de cinco minutos. `ENVIADA` significa aceita pelo FCM, nao exibida/lida.

## Operacao do worker

Ha processamento imediato no fluxo de oferta e um timer de 15 segundos, alem
do processamento ao iniciar a instancia. A fila e persistente no PostgreSQL.
Em Cloud Run com CPU somente durante requisicoes ou escala a zero, o timer nao
garante novas tentativas durante ociosidade. Para retentativas independentes do
trafego, executar `npm run fcm:process` em um job agendado a cada minuto, com a
identidade do servico e apenas DATABASE_URL, FCM_PROJECT_ID, NODE_ENV e LOG_LEVEL,
ou manter uma instancia com CPU sempre
alocada. Avaliar custos antes de alterar esse modo. Os envios novos nao dependem
desse agendamento: a oferta faz uma tentativa imediatamente.

Nao prometer entrega garantida: aparelho sem rede, permissao negada, canal
bloqueado, forcar parada e restricoes de bateria podem impedir ou atrasar alertas.
Depois de forcar parada e necessario reabrir o app.

## Homologacao em aparelho

### Comparacao com RastreiaAPP e duplicidade

Foi inspecionado o APK fornecido em `Downloads/app-debug.apk`, pacote
`br.com.rastreia.app`, versao 1.0.0, SHA-256
`A70D0F2485CF82319225B6301FBA0BFCF4087CA47D09E9B31A5CDD99CBFAD305`.
Ele corresponde ao APK local do RastreiaAPP. Nao possui FirebaseMessagingService
ou plugins PushNotifications/LocalNotifications. Seu index carrega
`main-KW6RSWPP.js`, que desativa o service worker em plataforma nativa. Os demais
bundles antigos presentes no ZIP nao sao o entrypoint. Portanto, esse arquivo
nao comprova a origem do alerta de entrega observado no telefone. Conferir o
aplicativo emissor nas informacoes da notificacao do Android antes de concluir.

Do backend RastreiaAPP foi reaproveitado o principio de identificacao estavel,
`renotify: false` e `topic` nas tentativas Web Push. No ADM, o identificador vem
da notificacao persistida e e comum ao inbox, VAPID e FCM. O service worker
serializa exibicoes e banners entre abas, guardando recibos limitados por
quantidade e idade; o APK compartilha os identificadores exibidos entre o
FirebaseMessagingService e o banner da WebView, sob o mesmo bloqueio de sessao.

VAPID continua exclusivo do navegador/PWA; FCM, do APK do motorista. Sao
instalacoes independentes: habilitar ambos no mesmo telefone pode produzir um
alerta em cada aplicativo. Nao desativar automaticamente outros dispositivos
do usuario nem tentar identifica-los por user-agent. Os recibos nao garantem
exactly-once diante de limpeza/falha de armazenamento, encerramento no momento
da exibicao ou uma versao antiga ainda instalada.

1. Instalar o APK atualizado, entrar como motorista e autorizar notificacoes.
2. Conferir Minha conta e enviar o teste. Com app aberto, conferir o banner.
3. Minimizar/bloquear a tela, solicitar corrida para uma empresa vinculada e
   conferir som, alerta e abertura da corrida ao tocar.
4. Repetir com outra empresa vinculada; uma empresa sem vinculo nao deve alertar.
5. Desativar notificacoes, sair e trocar de usuario; alertas antigos nao devem abrir.
6. Interromper/restabelecer rede e conferir novo registro e ofertas recentes.
7. Depois de receber um alerta com a tela bloqueada, reabrir o app e conferir que
   a mesma notificacao nao gera outro banner. No navegador, repetir com duas abas.

Compilacao, testes com transporte simulado e aceite da API FCM nao substituem
esses testes em Android real. Nunca registrar tokens FCM ou credenciais nos logs.
