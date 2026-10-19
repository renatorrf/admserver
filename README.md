# ADM Taxi Backend

## Senhas e recuperacao por email

**Antes de publicar esta alteracao, aplicar as migrations 014 e 015 com autorizacao.**
Elas adicionam senha temporaria, versao das credenciais, email master e tokens de recuperacao separados.
Nao foram aplicadas no banco remoto nesta implementacao. Nao executar o backend novo com o schema antigo.
A inicializacao verifica os registros da 014 e 015 e recusa iniciar sem eles, evitando anunciar uma API saudavel
que falharia nas consultas de autenticacao.

- Senhas novas: 6 a 128 caracteres, sem obrigar combinacoes de letras/numeros/simbolos.
- Novos usuarios de empresas (gestor, gerente, funcionario e prestador) devem trocar a senha inicial.
- Senha redefinida por cadastro administrativo volta a ser temporaria; senha escolhida pelo titular nao.
- Contas anteriores a 014 nao sao forcadas a trocar a senha automaticamente.
- A restricao do primeiro acesso e validada no backend HTTP e Socket.IO, alem dos guards do frontend.
- Troca pessoal exige senha atual e senha diferente; revoga tokens de acesso e refresh anteriores.
- Recuperacao: empresa + email cadastrado no acesso. Link aleatorio de uso unico, hash SHA-256 no banco,
  validade padrao de 30 minutos, sem enviar senhas. Nova solicitacao invalida links anteriores.
- Limites: 5 pedidos por IP/15 minutos (por instancia), 60 segundos entre envios e 5 por conta/hora
  (persistidos no banco, inclusive entre instancias). Resposta generica com janela minima de 10 segundos.
- Token fica no fragmento do link, removido da barra pelo frontend, e so e enviado ao backend no corpo
  do POST. Falha SMTP invalida o link e registra `RECUPERACAO_EMAIL_FALHOU` sem email ou segredo nos logs.
- Recuperacao conclui com novo login, nunca autentica automaticamente.
- O portal master mantem a troca obrigatoria inicial, agora com minimo de 6 caracteres. Novos masters
  exigem email unico (sem diferenciar maiusculas/minusculas); contas existentes preservam email vazio.
- Masters existentes cadastram o proprio email pelo icone de envelope no painel, confirmando a senha
  atual. O formulario abre automaticamente quando o email ainda nao foi cadastrado. Nao e possivel
  recuperar por email uma conta antiga antes desse cadastro; manter acesso ate concluir essa etapa.
- O login master oferece "Esqueci minha senha". A recuperacao pede apenas o email, nao uma empresa.
  Links/tabelas/rotas master sao separados dos usuarios empresariais, inclusive para o mesmo email.
- Troca de senha, email e inativacao master revogam sessoes e links anteriores; reativar nao restaura
  sessoes antigas. Ao salvar email/senha autenticado, apenas a sessao atual recebe um token novo.
- Falha de envio master registra somente `RECUPERACAO_MASTER_EMAIL_FALHOU`. Recuperacao e alteracao
  de email sao auditadas sem armazenar senha/token em texto puro.

As novas variaveis estao vazias em `.env` e `.env.example`; as configuracoes anteriores foram preservadas:

| Variavel | Preenchimento |
| --- | --- |
| SMTP_HOST | Servidor SMTP do provedor |
| SMTP_PORT | 587 (padrao, STARTTLS) ou 465 (TLS direto) |
| SMTP_SECURE | false para 587; true para 465 |
| SMTP_USER | Usuario SMTP |
| SMTP_PASSWORD | Senha de aplicativo/credencial SMTP |
| SMTP_FROM | Email remetente autorizado no provedor |
| PASSWORD_RESET_URL | URL HTTPS completa do frontend, terminada em `/redefinir-senha`, sem query/fragmento |
| MASTER_PASSWORD_RESET_URL | URL HTTPS completa do frontend, terminada em `/master/redefinir-senha`, sem query/fragmento |
| PASSWORD_RESET_TTL_MINUTES | 5 a 60; vazio usa 30 |

Todas vazias desabilitam apenas recuperacao por email (503 explicito); a troca autenticada continua ativa.
O portal master reutiliza SMTP/TTL; a sua URL vazia desabilita apenas a recuperacao master.
Configuracao parcial impede inicializacao para evitar envio mal configurado. TLS e verificacao de
certificado permanecem obrigatorios; nao usar `rejectUnauthorized=false`. O remetente deve estar
verificado no provedor; configurar SPF/DKIM e testar a entrega antes do piloto.
No Cloud Run, configurar variaveis/Secret Manager na revisao: o `.env` local nao e publicado automaticamente.
O link abre o frontend web/PWA, inclusive quando solicitado no APK; depois da troca, entrar novamente no APK.
Nao e necessario deep link Android para concluir a recuperacao.

Ordem de publicacao: backup validado -> validar/aplicar 014 e 015 -> publicar backend -> publicar frontend/APK
-> preencher SMTP/URL no ambiente -> testar email real e primeiro acesso. Nenhum deploy ou envio real
foi feito nesta implementacao. Manter as variaveis de banco/JWT existentes; nao substitui-las por valores vazios.

Validacao local: `npm test`, `npm run lint`, `npm run build` e `npm run test:password:integration`.
O teste de integracao cria PostgreSQL 18 isolado em loopback e nao utiliza DATABASE_URL.
Referencias: [Nodemailer SMTP](https://nodemailer.com/smtp),
[OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

## Revisao geral de 2026-10-15

Itinerarios individuais, isolamento de passageiros, idempotencia e testes com PostgreSQL
descartavel: veja `../docs/revisao-geral/RELATORIO_FINAL.md`. A migration `013` precisa ser
homologada antes de publicar esta versao. Nenhuma migration remota ou deploy foi feito nesta revisao.

`npm run test:review:integration` inicia um PostgreSQL privado em loopback, gera dados sinteticos,
aplica migrations e encerra o processo. Ignora `DATABASE_URL`; os clusters ficam em `.artifacts/`
(ignorado pelo Git). Usa a dependencia de desenvolvimento `embedded-postgres`; nao e banco de producao.
Executar com `npm ci` previamente e espaco em disco para os binarios/cluster.

API REST multiempresa do ADM Taxi. A API usa Node.js, TypeScript, Express e PostgreSQL sem ORM.

## Requisitos

- Node.js 22 ou superior.
- npm 11 ou superior.
- PostgreSQL com as extensoes `citext` e `pgcrypto`.
- Acesso ao schema `admtaxi` pela variavel `DATABASE_URL`.

O banco remoto atualmente executa PostgreSQL 9.6.24. O codigo e as migrations mantem
compatibilidade temporaria, mas essa versao esta fora de suporte e deve ser atualizada antes de
producao. O servidor tambem nao oferece TLS; nao use essa conexao em producao nem em redes nao
confiaveis antes de habilitar criptografia e verificacao de certificado.

## Configuracao local

Instale as dependencias:

```powershell
npm install
```

O arquivo `.env` e ignorado pelo Git. Para configura-lo sem imprimir segredos, defina
`DATABASE_URL` na sessao e execute:

```powershell
npm run env:configure
```

O utilitario preserva a URL existente quando executado novamente e gera segredos JWT aleatorios
quando necessario. Ele tambem gera `PROVISIONING_SECRET` sem exibir o valor. Em homologacao e
producao, injete todas as variaveis com o gerenciador de
segredos do ambiente. Consulte `.env.example` para a lista completa.

### Geoapify e Web Push

- `GEOAPIFY_API_KEY`: chave privada usada pelo backend no autocomplete e na geocodificacao reversa.
  Nao coloque essa chave no frontend.
- `PUSH_VAPID_SUBJECT`, `PUSH_VAPID_PUBLIC_KEY` e `PUSH_VAPID_PRIVATE_KEY`: identidade e par VAPID.
- `PUSH_APP_URL` e as URLs de icone, badge e abertura: destinos publicos HTTPS do PWA.
- Gere o par uma unica vez com `npm run push:vapid:generate`. Nao gere chaves durante o startup e
  nao altere o par enquanto existirem inscricoes ativas.

Sem essas variaveis, a API continua iniciando. A busca de enderecos retorna erro controlado `503`
e os envios push ficam registrados como ignorados, sem bloquear operacoes de corrida. Configuracao
VAPID parcial e rejeitada na inicializacao. Consulte `docs/WEB_PUSH_VAPID.md`.

## Banco de dados

```powershell
npm run migrate:status
npm run migrate:validate
npm run migrate
npm run db:inspect
```

`migrate:validate` executa as migrations pendentes em uma transacao e faz rollback completo.
Os rollbacks SQL existem, mas `migrate:down` exige `ALLOW_DESTRUCTIVE_MIGRATION=true` e nao deve
ser usado em producao sem aprovacao e backup verificado.

O seed e separado, exige confirmacao, senha com ao menos 12 caracteres e aceita somente PostgreSQL
local. Consulte `../OPERACAO_E_DEPLOY.md`. Nenhum seed foi executado no banco remoto.

## Execucao

### Cloud Run: logs e ambiente

Defina `NODE_ENV=production` nas variaveis de execucao do servico e use `npm start`
apos o build. Nao envie o `.env` local para a imagem; preserve os segredos no ambiente
do servico. A API gera logs JSON no Cloud Run (identificado por `K_SERVICE`) e em
saidas nao interativas. `pino-pretty` e opcional e usado somente no terminal local
de desenvolvimento, quando instalado. Sua ausencia nao impede a inicializacao.

Desenvolvimento com recarga automatica:

```powershell
npm run dev
```

Build e execucao compilada:

```powershell
npm run build
npm start
```

Endpoints iniciais:

- `GET /api/v1/health`: processo ativo.
- `GET /api/v1/ready`: conexao com o banco.
- `POST /api/v1/auth/login`: login por codigo da empresa, e-mail e senha.
- `POST /api/v1/auth/refresh`: rotacao do refresh token.
- `POST /api/v1/auth/logout`: revogacao do refresh token.
- `GET /api/v1/auth/me`: perfil autenticado.
- `POST /api/v1/provisionamento/empresas`: cria empresa e primeiro gestor quando habilitado.
- `/api/v1/master`: login e administracao visual da plataforma.
- `GET|PATCH /api/v1/empresas/atual`: consulta e atualiza a empresa autenticada.
- `/api/v1/usuarios`: CRUD logico e filtros de usuarios.
- `/api/v1/usuarios/:id/centros-custo`: vinculos de centros de custo do gerente.
- `/api/v1/prestadores`: CRUD logico e filtros de prestadores.
- `/api/v1/veiculos`: CRUD logico e filtros de veiculos.
- `/api/v1/centros-custo`: CRUD logico e filtros de centros de custo.
- `/api/v1/funcionarios`: CRUD logico e filtros de funcionarios.
- `GET /api/v1/auditoria`: historico auditavel da empresa.
- `/api/v1/corridas`: solicitacao, listagem e consulta conforme o perfil.
- `/api/v1/corridas/:id/atribuir`: atribuicao pelo gestor.
- `/api/v1/corridas/:id/aceitar` e `/recusar`: resposta do prestador.
- `/api/v1/corridas/:id/iniciar-deslocamento`: inicio do atendimento.
- `/api/v1/corridas/:id/cheguei-embarque`: chegada ao passageiro.
- `/api/v1/corridas/:id/confirmar-embarque`: inicio da corrida.
- `/api/v1/corridas/:id/confirmar-desembarque`: desembarque do passageiro.
- `/api/v1/corridas/:id/finalizar`: valor final e encerramento.
- `/api/v1/corridas/:id/cancelar` e `/reabrir`: fluxos alternativos autorizados.
- `PATCH /api/v1/prestadores/minha-disponibilidade`: disponibilidade do prestador autenticado.
- `GET|POST /api/v1/corridas/:id/localizacoes`: historico e envio controlado de posicao.
- `GET /api/v1/dashboard`: indicadores e acompanhamento consolidado.
- `GET /api/v1/relatorios/corridas`: relatorio paginado com filtros e totais.
- `GET /api/v1/relatorios/corridas.csv`: exportacao CSV limitada a 10.000 linhas.
- `GET /api/v1/paineis/meu`: painel isolado do funcionario ou prestador autenticado.
- `/api/v1/faturamentos`: resumo, elegibilidade, fechamento, cancelamento e CSV financeiro.
- `/api/v1/push`: chave publica, inscricoes, teste e diagnostico Web Push VAPID.
- `/socket.io`: acompanhamento autenticado de corridas e localizacoes em tempo real.
- `GET /api/docs`: Swagger UI.
- `GET /api/openapi.json`: especificacao OpenAPI.

Payload de login:

```json
{
  "empresa": "ADM-DEMO",
  "email": "usuario@exemplo.com",
  "senha": "senha-do-usuario"
}
```

O campo `empresa` corresponde a `empresas.codigo_acesso`. Ele e necessario porque o mesmo
e-mail pode existir em empresas diferentes.

## Provisionamento da primeira empresa

O endpoint fica desabilitado quando `PROVISIONING_SECRET` nao existe. Em desenvolvimento local,
execute `npm run env:configure`, reinicie a API e use o script PowerShell. A senha e solicitada de
forma oculta e nao deve ser passada como argumento:

```powershell
.\scripts\criar-empresa-gestor.ps1 `
  -CodigoAcesso 'ADM-BR' `
  -RazaoSocial 'ADM do Brasil Ltda' `
  -NomeFantasia 'ADM Brasil' `
  -GestorNome 'Gestor Principal' `
  -GestorEmail 'gestor@empresa.com.br' `
  -Cnpj '00000000000000' `
  -Telefone '(11) 3000-0000'
```

O segredo segue no header `X-Provisioning-Secret`; a senha usa Argon2id e nunca aparece na
resposta ou auditoria. O endpoint aceita no maximo cinco tentativas por hora e deve permanecer
desabilitado em producao quando nao houver provisionamentos autorizados.

Para operacao recorrente, use o portal visual em `http://localhost:8101/master`. Ele permite criar
empresas e administradores master sem scripts. O primeiro acesso exige troca da senha temporaria.
Consulte `docs/ADMINISTRACAO_PLATAFORMA.md`.

Os CRUDs administrativos aceitam `GET`, `POST` e `PATCH`. Inativacao e reativacao usam
`POST /:id/inativar` e `POST /:id/reativar`; nao existem rotas `DELETE`. Listagens aceitam
`pagina`, `limite`, `busca` e `ativo`, alem dos filtros especificos documentados no OpenAPI.

## Seguranca multiempresa

- `empresa_id` vem exclusivamente do token emitido pelo backend em rotas autenticadas.
- Repositorios devem filtrar por `empresa_id` em todas as consultas de negocio.
- Chaves estrangeiras compostas impedem vinculos entre registros de empresas diferentes.
- Senhas usam Argon2id; apenas hashes de refresh tokens sao persistidos.
- Logs removem authorization, cookies, senhas, tokens e URL do banco.
- Erros de login nao distinguem usuario inexistente de senha incorreta.
- `authorize(...)` restringe rotas aos perfis `PRESTADOR`, `FUNCIONARIO`, `GERENTE` e `GESTOR`.
- As rotas administrativas da Fase 3 sao exclusivas de `GESTOR`.
- Alteracoes administrativas e vinculos sao auditados na mesma transacao do cadastro.

A matriz completa esta em `docs/MATRIZ_PERMISSOES.md`, a maquina de estados em
`docs/FLUXO_CORRIDAS.md`, o contrato de rastreamento em `docs/GEOLOCALIZACAO_E_TEMPO_REAL.md` e
os indicadores em `docs/DASHBOARD_E_RELATORIOS.md`. Faturamento e push estao documentados em
`docs/FATURAMENTO.md` e `docs/WEB_PUSH_VAPID.md`.

## Qualidade

```powershell
npm run lint
npm test
npm run build
```

Os testes cobrem autenticacao, rotacao de token, escopo por empresa, autorizacao, cadastros,
inativacao, auditoria, maquina de estados, fluxos operacionais, geolocalizacao, dashboard,
relatorios, CSV e protecoes do seed de desenvolvimento.
