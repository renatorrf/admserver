# ADM Taxi Backend

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
