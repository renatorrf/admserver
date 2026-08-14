const bearerSecurity = [{ bearerAuth: [] }];
const idParameter = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const reportFilterParameters = [
  { name: 'inicio', in: 'query', schema: { type: 'string', format: 'date-time' } },
  { name: 'fim', in: 'query', schema: { type: 'string', format: 'date-time' } },
  { name: 'status', in: 'query', schema: { type: 'string' } },
  { name: 'centroCustoId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'funcionarioId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'prestadorId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'solicitanteUsuarioId', in: 'query', schema: { type: 'string', format: 'uuid' } },
] as const;

function catalogPaths(tag: string, label: string) {
  return {
    collection: {
      get: {
        tags: [tag], summary: `Lista ${label}`, security: bearerSecurity,
        parameters: [
          { name: 'pagina', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limite', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'busca', in: 'query', schema: { type: 'string' } },
          { name: 'ativo', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': { description: 'Lista paginada' }, '403': { description: 'Acesso restrito a GESTOR' } },
      },
      post: {
        tags: [tag], summary: `Cria ${label}`, security: bearerSecurity,
        responses: { '201': { description: 'Registro criado' }, '409': { description: 'Registro duplicado' } },
      },
    },
    item: {
      parameters: [idParameter],
      get: {
        tags: [tag], summary: `Consulta ${label}`, security: bearerSecurity,
        responses: { '200': { description: 'Registro encontrado' }, '404': { description: 'Registro nao encontrado' } },
      },
      patch: {
        tags: [tag], summary: `Atualiza ${label}`, security: bearerSecurity,
        responses: { '200': { description: 'Registro atualizado' }, '422': { description: 'Dados invalidos' } },
      },
    },
    inativar: {
      parameters: [idParameter],
      post: {
        tags: [tag], summary: `Inativa ${label}`, security: bearerSecurity,
        responses: { '200': { description: 'Registro inativado' } },
      },
    },
    reativar: {
      parameters: [idParameter],
      post: {
        tags: [tag], summary: `Reativa ${label}`, security: bearerSecurity,
        responses: { '200': { description: 'Registro reativado' } },
      },
    },
  };
}

const usuarios = catalogPaths('Usuarios', 'usuarios');
const prestadores = catalogPaths('Prestadores', 'prestadores');
const veiculos = catalogPaths('Veiculos', 'veiculos');
const setores = catalogPaths('Setores', 'setores');
const centrosCusto = catalogPaths('Centros de custo', 'centros de custo');
const funcionarios = catalogPaths('Funcionarios', 'funcionarios');

function rideAction(summary: string, profiles: string) {
  return {
    parameters: [idParameter],
    post: {
      tags: ['Corridas'], summary, description: `Perfis permitidos: ${profiles}.`, security: bearerSecurity,
      responses: {
        '200': { description: 'Corrida atualizada' },
        '403': { description: 'Perfil ou corrida sem acesso' },
        '409': { description: 'Acao incompativel com o estado atual' },
      },
    },
  };
}

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'ADM Taxi API',
    version: '1.0.0',
    description: 'API multiempresa para gestao corporativa de corridas de taxi.',
  },
  servers: [{ url: '/api/v1' }],
  'x-socket-io': {
    path: '/socket.io',
    authentication: 'Access token JWT em handshake.auth.token.',
    clientEvents: ['corrida:acompanhar', 'corrida:parar-acompanhamento', 'localizacao:enviar'],
    serverEvents: [
      'corrida:atualizada', 'corrida:criada', 'corrida:ofertada', 'corrida:aceita',
      'corrida:status-alterado', 'corrida:finalizada', 'corrida:cancelada', 'corrida:valor-alterado',
      'corrida:lista-invalidada',
      'faturamento:criado', 'faturamento:cancelado', 'localizacao:atualizada',
    ],
  },
  tags: [
    { name: 'Auth' }, { name: 'Health' }, { name: 'Empresa' }, { name: 'Usuarios' },
    { name: 'Prestadores' }, { name: 'Cadastros unificados' }, { name: 'Veiculos' }, { name: 'Setores' }, { name: 'Centros de custo' },
    { name: 'Funcionarios' }, { name: 'Auditoria' }, { name: 'Operacao' },
    { name: 'Corridas' }, { name: 'Localizacoes' }, { name: 'Dashboard' }, { name: 'Relatorios' },
    { name: 'Enderecos' }, { name: 'Notificacoes' }, { name: 'Dispositivos' }, { name: 'Provisionamento' },
    { name: 'Paineis' }, { name: 'Faturamentos' }, { name: 'Master' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Verifica se o processo esta ativo',
        responses: { '200': { description: 'Processo ativo' } },
      },
    },
    '/ready': {
      get: {
        tags: ['Health'],
        summary: 'Verifica a conexao com o PostgreSQL',
        responses: {
          '200': { description: 'API pronta' },
          '503': { description: 'Banco indisponivel' },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Autentica um usuario',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['empresa', 'email', 'senha'],
                properties: {
                  empresa: { type: 'string', example: 'ADM-DEMO' },
                  email: { type: 'string', format: 'email' },
                  senha: { type: 'string', format: 'password' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Sessao criada' },
          '401': { description: 'Credenciais invalidas' },
          '422': { description: 'Dados invalidos' },
          '429': { description: 'Muitas tentativas' },
        },
      },
    },
    '/auth/empresas': {
      get: {
        tags: ['Auth'],
        summary: 'Lista empresas ativas para selecao no login',
        responses: {
          '200': { description: 'Codigos de acesso e nomes fantasia das empresas ativas' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotaciona o refresh token',
        responses: {
          '200': { description: 'Tokens rotacionados' },
          '401': { description: 'Sessao invalida ou expirada' },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Revoga o refresh token',
        responses: { '204': { description: 'Sessao encerrada' } },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Retorna o usuario autenticado',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Usuario atual' },
          '401': { description: 'Nao autenticado' },
        },
      },
    },
    '/provisionamento/empresas': {
      post: {
        tags: ['Provisionamento'],
        summary: 'Cria uma empresa e seu primeiro usuario gestor',
        description: 'Endpoint desabilitado quando PROVISIONING_SECRET nao esta configurado. A operacao e transacional.',
        parameters: [{
          name: 'X-Provisioning-Secret', in: 'header', required: true,
          schema: { type: 'string', minLength: 32, format: 'password' },
        }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ProvisionamentoInput' } } },
        },
        responses: {
          '201': { description: 'Empresa e gestor criados' },
          '401': { description: 'Credencial de provisionamento invalida' },
          '409': { description: 'Codigo, CNPJ ou e-mail duplicado' },
          '422': { description: 'Dados invalidos' },
          '429': { description: 'Limite de tentativas excedido' },
        },
      },
    },
    '/master/auth/login': {
      post: {
        tags: ['Master'], summary: 'Autentica administrador da plataforma',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', additionalProperties: false, required: ['usuario', 'senha'],
          properties: { usuario: { type: 'string' }, senha: { type: 'string', format: 'password' } },
        } } } },
        responses: { '200': { description: 'Sessao master criada' }, '401': { description: 'Credenciais invalidas' }, '429': { description: 'Muitas tentativas' } },
      },
    },
    '/master/auth/me': {
      get: {
        tags: ['Master'], summary: 'Consulta o administrador master autenticado', security: [{ masterBearer: [] }],
        responses: { '200': { description: 'Administrador atual' }, '401': { description: 'Sessao invalida' } },
      },
    },
    '/master/auth/senha': {
      post: {
        tags: ['Master'], summary: 'Altera a propria senha master', security: [{ masterBearer: [] }],
        responses: { '200': { description: 'Senha alterada e novo token emitido' }, '401': { description: 'Senha atual incorreta' } },
      },
    },
    '/master/empresas': {
      get: {
        tags: ['Master'], summary: 'Lista empresas da plataforma', security: [{ masterBearer: [] }],
        responses: { '200': { description: 'Empresas e quantidade de usuarios' }, '409': { description: 'Troca de senha inicial pendente' } },
      },
      post: {
        tags: ['Master'], summary: 'Cria empresa e seu primeiro gestor', security: [{ masterBearer: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ProvisionamentoInput' } } },
        },
        responses: { '201': { description: 'Empresa provisionada de forma transacional' }, '409': { description: 'Registro duplicado ou troca de senha pendente' } },
      },
    },
    '/master/administradores': {
      get: {
        tags: ['Master'], summary: 'Lista administradores da plataforma', security: [{ masterBearer: [] }],
        responses: { '200': { description: 'Administradores sem hashes de senha' } },
      },
      post: {
        tags: ['Master'], summary: 'Cria administrador master com senha temporaria', security: [{ masterBearer: [] }],
        responses: { '201': { description: 'Administrador criado com troca de senha obrigatoria' }, '409': { description: 'Usuario duplicado' } },
      },
    },
    '/master/administradores/{id}/ativo': {
      parameters: [idParameter],
      patch: {
        tags: ['Master'], summary: 'Ativa ou inativa administrador master', security: [{ masterBearer: [] }],
        responses: { '200': { description: 'Administrador atualizado' }, '409': { description: 'Auto-inativacao bloqueada' } },
      },
    },
    '/empresas/atual': {
      get: {
        tags: ['Empresa'], summary: 'Consulta a empresa autenticada', security: bearerSecurity,
        responses: { '200': { description: 'Empresa atual' }, '403': { description: 'Acesso restrito a GESTOR' } },
      },
      patch: {
        tags: ['Empresa'], summary: 'Atualiza a empresa autenticada', security: bearerSecurity,
        responses: { '200': { description: 'Empresa atualizada' }, '409': { description: 'Codigo ou CNPJ duplicado' } },
      },
    },
    '/usuarios': usuarios.collection,
    '/usuarios/{id}': usuarios.item,
    '/usuarios/{id}/inativar': usuarios.inativar,
    '/usuarios/{id}/reativar': usuarios.reativar,
    '/usuarios/{id}/centros-custo': {
      parameters: [idParameter],
      get: {
        tags: ['Usuarios'], summary: 'Lista centros autorizados do gerente', security: bearerSecurity,
        responses: { '200': { description: 'Centros vinculados' } },
      },
      put: {
        tags: ['Usuarios'], summary: 'Substitui centros autorizados do gerente', security: bearerSecurity,
        responses: { '200': { description: 'Vinculos substituidos' }, '422': { description: 'Centro invalido' } },
      },
    },
    '/prestadores': prestadores.collection,
    '/prestadores/{id}': prestadores.item,
    '/prestadores/{id}/inativar': prestadores.inativar,
    '/prestadores/{id}/reativar': prestadores.reativar,
    '/cadastros-unificados/veiculos': {
      get: {
        tags: ['Cadastros unificados'], summary: 'Pesquisa veiculos elegiveis para vinculo', security: bearerSecurity,
        description: 'Retorna somente veiculos ativos da empresa autenticada e informa se estao livres ou ja vinculados ao prestador em edicao.',
        parameters: [
          { name: 'busca', in: 'query', schema: { type: 'string' } },
          { name: 'prestadorId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'pagina', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limite', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: { '200': { description: 'Veiculos ativos no escopo do tenant' }, '403': { description: 'Acesso restrito a GESTOR' } },
      },
    },
    '/usuarios/escopo/preview': {
      post: {
        tags: ['Usuarios'], summary: 'Calcula a visibilidade de um escopo de gerente', security: bearerSecurity,
        description: 'Valida setores e centros da empresa autenticada sem alterar vinculos.',
        responses: { '200': { description: 'Quantidade de funcionarios visiveis' }, '422': { description: 'Escopo invalido' } },
      },
    },
    '/usuarios/{id}/escopo': {
      parameters: [idParameter],
      get: {
        tags: ['Usuarios'], summary: 'Consulta setores e centros autorizados do gerente', security: bearerSecurity,
        responses: { '200': { description: 'Escopo e quantidade de funcionarios visiveis' } },
      },
      put: {
        tags: ['Usuarios'], summary: 'Substitui o escopo operacional do gerente', security: bearerSecurity,
        description: 'A operacao valida mesma empresa, setores ativos e centros pertencentes aos setores selecionados.',
        responses: { '200': { description: 'Escopo substituido e auditado' }, '422': { description: 'Setor ou centro invalido' } },
      },
    },
    '/cadastros-unificados/prestadores': {
      post: {
        tags: ['Cadastros unificados'], summary: 'Cria acesso, prestador e vinculo de veiculo em uma transacao', security: bearerSecurity,
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PrestadorUnificadoCreateInput' } } } },
        responses: {
          '201': { description: 'Cadastro unificado criado' },
          '403': { description: 'Acesso restrito a GESTOR' },
          '409': { description: 'E-mail, CPF, CNH ou placa duplicada, ou veiculo ja vinculado' },
          '422': { description: 'Dados invalidos ou referencia fora da empresa' },
        },
      },
    },
    '/cadastros-unificados/prestadores/{id}': {
      parameters: [idParameter],
      get: {
        tags: ['Cadastros unificados'], summary: 'Consulta acesso, prestador, veiculos e dispositivos', security: bearerSecurity,
        responses: { '200': { description: 'Cadastro unificado' }, '403': { description: 'Acesso restrito a GESTOR' }, '404': { description: 'Prestador nao encontrado' } },
      },
      patch: {
        tags: ['Cadastros unificados'], summary: 'Atualiza o cadastro unificado em uma transacao', security: bearerSecurity,
        description: 'Trocas e desvinculos de veiculo sao auditados. Inativar acesso ou prestador inativa ambos, remove a disponibilidade e revoga sessoes.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PrestadorUnificadoUpdateInput' } } } },
        responses: {
          '200': { description: 'Cadastro unificado atualizado' }, '403': { description: 'Acesso restrito a GESTOR' },
          '409': { description: 'Duplicidade ou veiculo ja vinculado' }, '422': { description: 'Dados invalidos ou referencia fora da empresa' },
        },
      },
    },
    '/cadastros-unificados/funcionarios': {
      post: {
        tags: ['Cadastros unificados'], summary: 'Cria usuario e funcionario em uma transacao', security: bearerSecurity,
        description: 'O nome, e-mail e telefone do funcionario tambem compoem o usuario de acesso com perfil FUNCIONARIO.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/FuncionarioUnificadoCreateInput' } } } },
        responses: {
          '201': { description: 'Usuario e funcionario criados' }, '403': { description: 'Acesso restrito a GESTOR' },
          '409': { description: 'E-mail, matricula ou CPF duplicado' }, '422': { description: 'Dados invalidos ou centro fora da empresa' },
        },
      },
    },
    '/cadastros-unificados/funcionarios/{id}': {
      parameters: [idParameter],
      patch: {
        tags: ['Cadastros unificados'], summary: 'Atualiza usuario e funcionario em uma transacao', security: bearerSecurity,
        description: 'Inativar uma das partes inativa ambas e revoga as sessoes. Uma nova senha e opcional quando o usuario ja existe.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/FuncionarioUnificadoUpdateInput' } } } },
        responses: {
          '200': { description: 'Usuario e funcionario atualizados' }, '403': { description: 'Acesso restrito a GESTOR' },
          '409': { description: 'Registro duplicado' }, '422': { description: 'Dados invalidos ou vinculo fora da empresa' },
        },
      },
    },
    '/veiculos': veiculos.collection,
    '/veiculos/{id}': veiculos.item,
    '/veiculos/{id}/inativar': veiculos.inativar,
    '/veiculos/{id}/reativar': veiculos.reativar,
    '/setores': setores.collection,
    '/setores/{id}': setores.item,
    '/setores/{id}/inativar': setores.inativar,
    '/setores/{id}/reativar': setores.reativar,
    '/centros-custo': centrosCusto.collection,
    '/centros-custo/{id}': centrosCusto.item,
    '/centros-custo/{id}/inativar': centrosCusto.inativar,
    '/centros-custo/{id}/reativar': centrosCusto.reativar,
    '/funcionarios': funcionarios.collection,
    '/funcionarios/{id}': funcionarios.item,
    '/funcionarios/{id}/inativar': funcionarios.inativar,
    '/funcionarios/{id}/reativar': funcionarios.reativar,
    '/auditoria': {
      get: {
        tags: ['Auditoria'], summary: 'Consulta a auditoria da empresa', security: bearerSecurity,
        parameters: [
          { name: 'entidade', in: 'query', schema: { type: 'string' } },
          { name: 'acao', in: 'query', schema: { type: 'string' } },
          { name: 'usuarioId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'inicio', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'fim', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'Eventos paginados da empresa autenticada' } },
      },
    },
    '/operacao/centros-custo': {
      get: {
        tags: ['Operacao'], summary: 'Lista centros disponiveis para solicitar corridas', security: bearerSecurity,
        description: 'GESTOR recebe os centros ativos da empresa. GERENTE recebe somente os centros autorizados.',
        responses: { '200': { description: 'Centros ativos no escopo do perfil' }, '403': { description: 'Perfil nao permitido' } },
      },
    },
    '/operacao/funcionarios': {
      get: {
        tags: ['Operacao'], summary: 'Lista funcionarios disponiveis para solicitar corridas', security: bearerSecurity,
        parameters: [{ name: 'centroCustoId', in: 'query', schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Funcionarios ativos no escopo do perfil' }, '403': { description: 'Perfil nao permitido' } },
      },
    },
    '/operacao/escopo': {
      get: {
        tags: ['Operacao'], summary: 'Consulta o escopo operacional autenticado', security: bearerSecurity,
        description: 'GESTOR recebe a empresa inteira. GERENTE recebe somente setores, centros e quantidade de funcionarios autorizados.',
        responses: { '200': { description: 'Escopo operacional atual' }, '403': { description: 'Perfil nao permitido' } },
      },
    },
    '/operacao/setores': {
      get: {
        tags: ['Operacao'], summary: 'Lista setores no escopo autenticado', security: bearerSecurity,
        responses: { '200': { description: 'Setores ativos permitidos' }, '403': { description: 'Perfil nao permitido' } },
      },
    },
    '/operacao/funcionarios/pesquisa': {
      get: {
        tags: ['Operacao'], summary: 'Pesquisa funcionarios com paginacao', security: bearerSecurity,
        description: 'Filtra pela empresa autenticada e, para GERENTE, pelos centros autorizados.',
        responses: { '200': { description: 'Funcionarios paginados' }, '403': { description: 'Perfil nao permitido' } },
      },
    },
    '/operacao/meu-prestador': {
      get: {
        tags: ['Operacao'], summary: 'Consulta o prestador do usuario autenticado', security: bearerSecurity,
        responses: { '200': { description: 'Prestador, estado ativo e disponibilidade' }, '404': { description: 'Usuario sem prestador ativo' } },
      },
    },
    '/operacao/meus-veiculos': {
      get: {
        tags: ['Operacao'], summary: 'Lista veiculos ativos do prestador autenticado', security: bearerSecurity,
        responses: { '200': { description: 'Veiculos disponiveis para aceite' }, '403': { description: 'Perfil nao permitido' } },
      },
    },
    '/operacao/prestadores': {
      get: {
        tags: ['Operacao'], summary: 'Lista prestadores para filtros operacionais', security: bearerSecurity,
        description: 'Perfis permitidos: GERENTE e GESTOR.',
        responses: { '200': { description: 'Gestor recebe a empresa; gerente recebe prestadores presentes em corridas do escopo' }, '403': { description: 'Perfil nao permitido' } },
      },
    },
    '/operacao/prestadores/pesquisa': {
      get: {
        tags: ['Operacao'], summary: 'Pesquisa prestadores com paginacao', security: bearerSecurity,
        description: 'Pesquisa nome, CPF, telefone, CNH ou placa e permite filtrar ativos e disponiveis.',
        responses: { '200': { description: 'Prestadores paginados da empresa autenticada' } },
      },
    },
    '/enderecos/autocomplete': {
      get: {
        tags: ['Enderecos'], summary: 'Busca sugestoes de endereco no Geoapify', security: bearerSecurity,
        description: 'Usa coordenadas informadas como vies; sem elas usa a regiao da empresa autenticada.',
        responses: { '200': { description: 'Sugestoes com descricao e coordenadas' }, '503': { description: 'Geoapify indisponivel ou nao configurado' } },
      },
    },
    '/enderecos/reverso': {
      get: {
        tags: ['Enderecos'], summary: 'Converte coordenadas em endereco', security: bearerSecurity,
        responses: { '200': { description: 'Endereco identificado ou nulo' }, '503': { description: 'Geoapify indisponivel' } },
      },
    },
    '/push/public-key': {
      get: {
        tags: ['Notificacoes'], summary: 'Retorna a chave publica VAPID',
        responses: { '200': { description: 'Chave publica para criar a inscricao Web Push' }, '503': { description: 'Web Push nao configurado' } },
      },
    },
    '/push/subscriptions': {
      post: {
        tags: ['Notificacoes'], summary: 'Registra ou reativa uma inscricao Web Push', security: bearerSecurity,
        responses: { '201': { description: 'Inscricao registrada sem expor as chaves privadas' }, '422': { description: 'Inscricao invalida' } },
      },
    },
    '/push/subscriptions/status': {
      get: {
        tags: ['Notificacoes'], summary: 'Consulta as inscricoes Web Push do usuario', security: bearerSecurity,
        responses: { '200': { description: 'Configuracao do servidor e inscricoes ativas/inativas' } },
      },
    },
    '/push/subscriptions/{id}': {
      parameters: [idParameter],
      delete: {
        tags: ['Notificacoes'], summary: 'Inativa uma inscricao Web Push do usuario', security: bearerSecurity,
        responses: { '204': { description: 'Inscricao inativada' }, '404': { description: 'Inscricao fora do usuario ou empresa' } },
      },
    },
    '/push/test': {
      post: {
        tags: ['Notificacoes'], summary: 'Envia uma notificacao de teste', security: bearerSecurity,
        responses: { '204': { description: 'Tentativa registrada para o usuario autenticado' } },
      },
    },
    '/push/diagnostics': {
      get: {
        tags: ['Notificacoes'], summary: 'Lista diagnosticos Web Push da empresa', security: bearerSecurity,
        description: 'Acesso exclusivo do perfil GESTOR. Nao retorna endpoint completo, p256dh ou auth.',
        responses: { '200': { description: 'Usuarios, inscricoes e ultimo resultado de envio' }, '403': { description: 'Acesso restrito a GESTOR' } },
      },
    },
    '/push/diagnostics/{id}/test': {
      parameters: [idParameter],
      post: {
        tags: ['Notificacoes'], summary: 'Envia teste para uma inscricao da empresa', security: bearerSecurity,
        description: 'Acesso exclusivo do perfil GESTOR.',
        responses: { '204': { description: 'Tentativa registrada' }, '404': { description: 'Inscricao nao encontrada no tenant' } },
      },
    },
    '/dispositivos/atual': {
      put: {
        tags: ['Dispositivos'], summary: 'Sincroniza permissoes e modo de acesso do dispositivo atual', security: bearerSecurity,
        responses: { '200': { description: 'Dispositivo sincronizado' }, '422': { description: 'Estado do dispositivo invalido' } },
      },
    },
    '/dispositivos/atual/{chaveDispositivo}': {
      parameters: [{ name: 'chaveDispositivo', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      delete: {
        tags: ['Dispositivos'], summary: 'Marca o dispositivo atual como desconectado', security: bearerSecurity,
        responses: { '204': { description: 'Dispositivo marcado como inativo' } },
      },
    },
    '/dispositivos': {
      get: {
        tags: ['Dispositivos'], summary: 'Lista dispositivos e permissoes dos usuarios da empresa', security: bearerSecurity,
        description: 'Acesso exclusivo do perfil GESTOR.',
        parameters: [
          { name: 'pagina', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limite', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'busca', in: 'query', schema: { type: 'string' } },
          { name: 'ativo', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': { description: 'Dispositivos paginados com usuario e permissoes' }, '403': { description: 'Acesso restrito a GESTOR' } },
      },
    },
    '/operacao/solicitantes': {
      get: {
        tags: ['Operacao'], summary: 'Lista solicitantes para filtros operacionais', security: bearerSecurity,
        description: 'GESTOR recebe solicitantes ativos da empresa. GERENTE recebe somente o proprio usuario.',
        responses: { '200': { description: 'Solicitantes no escopo do perfil' }, '403': { description: 'Perfil nao permitido' } },
      },
    },
    '/dashboard': {
      get: {
        tags: ['Dashboard'], summary: 'Consolida indicadores operacionais e financeiros', security: bearerSecurity,
        description: 'Perfis permitidos: GERENTE e GESTOR. O gerente recebe somente centros de custo autorizados.',
        responses: { '200': { description: 'Indicadores, custos, evolucao, corridas ativas e proximas corridas' }, '403': { description: 'Perfil nao permitido' } },
      },
    },
    '/relatorios/corridas': {
      get: {
        tags: ['Relatorios'], summary: 'Consulta o relatorio analitico de corridas', security: bearerSecurity,
        description: 'Perfis permitidos: GERENTE e GESTOR. Valores e totais respeitam o escopo de centros do gerente.',
        parameters: [
          { name: 'pagina', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limite', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          ...reportFilterParameters,
        ],
        responses: { '200': { description: 'Linhas paginadas, resumo e custos agrupados' }, '403': { description: 'Perfil ou filtro fora do escopo' } },
      },
    },
    '/relatorios/corridas.csv': {
      get: {
        tags: ['Relatorios'], summary: 'Exporta o relatorio de corridas em CSV', security: bearerSecurity,
        parameters: reportFilterParameters,
        responses: {
          '200': { description: 'CSV UTF-8 delimitado por ponto e virgula, limitado a 10.000 linhas', content: { 'text/csv': {} } },
          '403': { description: 'Perfil ou filtro fora do escopo' },
        },
      },
    },
    '/paineis/meu': {
      get: {
        tags: ['Paineis'], summary: 'Consulta o painel individual do participante', security: bearerSecurity,
        description: 'FUNCIONARIO recebe somente corridas vinculadas ao proprio cadastro; PRESTADOR recebe somente atribuicoes proprias.',
        parameters: [
          { name: 'inicio', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'fim', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'pagina', in: 'query', schema: { type: 'integer', minimum: 1 } },
          { name: 'limite', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        responses: { '200': { description: 'Resumo realizado e historico paginado' }, '403': { description: 'Perfil sem painel individual' } },
      },
    },
    '/faturamentos/resumo': {
      get: {
        tags: ['Faturamentos'], summary: 'Resume a situacao financeira do periodo', security: bearerSecurity,
        description: 'Exclusivo do GESTOR. Agrupa por prestador, setor, centro de custo e funcionario.',
        responses: { '200': { description: 'Totais, medias, pendencias e agrupamentos' }, '403': { description: 'Acesso negado' } },
      },
    },
    '/faturamentos/elegiveis': {
      get: {
        tags: ['Faturamentos'], summary: 'Lista corridas elegiveis para fechamento', security: bearerSecurity,
        description: 'Exclusivo do GESTOR. Exige periodo e prestador; retorna somente finalizadas com valor e sem item ativo.',
        responses: { '200': { description: 'Corridas elegiveis do tenant' }, '403': { description: 'Acesso negado' } },
      },
    },
    '/faturamentos': {
      get: {
        tags: ['Faturamentos'], summary: 'Lista fechamentos financeiros', security: bearerSecurity,
        description: 'GESTOR consulta a empresa; PRESTADOR consulta somente os proprios fechamentos.',
        responses: { '200': { description: 'Fechamentos paginados' }, '403': { description: 'Perfil nao permitido' } },
      },
      post: {
        tags: ['Faturamentos'], summary: 'Fecha corridas elegiveis em uma transacao', security: bearerSecurity,
        description: 'Exclusivo do GESTOR. Preserva valor por item e exige motivo para cada exclusao.',
        responses: { '201': { description: 'Faturamento fechado' }, '409': { description: 'Elegibilidade mudou durante a revisao' } },
      },
    },
    '/faturamentos/{id}': {
      parameters: [idParameter],
      get: {
        tags: ['Faturamentos'], summary: 'Consulta fechamento e itens', security: bearerSecurity,
        responses: { '200': { description: 'Fechamento dentro do escopo' }, '404': { description: 'Fechamento sem acesso' } },
      },
    },
    '/faturamentos/{id}/csv': {
      parameters: [idParameter],
      get: {
        tags: ['Faturamentos'], summary: 'Exporta os itens congelados em CSV', security: bearerSecurity,
        responses: { '200': { description: 'CSV UTF-8 delimitado por ponto e virgula', content: { 'text/csv': {} } } },
      },
    },
    '/faturamentos/{id}/cancelar': {
      parameters: [idParameter],
      post: {
        tags: ['Faturamentos'], summary: 'Cancela logicamente um fechamento', security: bearerSecurity,
        description: 'Exclusivo do GESTOR. Preserva itens e exige motivo.',
        responses: { '200': { description: 'Faturamento cancelado' }, '409': { description: 'Estado incompativel' } },
      },
    },
    '/faturamentos/corridas/{id}/valor-final': {
      parameters: [idParameter],
      patch: {
        tags: ['Faturamentos'], summary: 'Corrige o valor final com justificativa', security: bearerSecurity,
        description: 'Exclusivo do GESTOR. Bloqueado enquanto a corrida participar de fechamento ativo.',
        responses: { '200': { description: 'Valor corrigido e auditado' }, '409': { description: 'Corrida faturada ou nao finalizada' } },
      },
    },
    '/corridas': {
      get: {
        tags: ['Corridas'], summary: 'Lista corridas conforme o perfil autenticado', security: bearerSecurity,
        description: 'GESTOR ve a empresa; GERENTE ve centros autorizados; PRESTADOR ve as proprias corridas e ofertas; FUNCIONARIO ve somente corridas vinculadas ao proprio cadastro.',
        parameters: [
          { name: 'pagina', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limite', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'tipo', in: 'query', schema: { type: 'string', enum: ['IMEDIATA', 'AGENDADA'] } },
          { name: 'centroCustoId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'funcionarioId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'prestadorId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'inicio', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'fim', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'Lista paginada e limitada ao tenant' } },
      },
      post: {
        tags: ['Corridas'], summary: 'Solicita corrida', description: 'Perfis permitidos: GERENTE e GESTOR.',
        security: bearerSecurity,
        responses: { '201': { description: 'Corrida solicitada' }, '422': { description: 'Funcionario ou centro invalido' } },
      },
    },
    '/corridas/{id}': {
      parameters: [idParameter],
      get: {
        tags: ['Corridas'], summary: 'Consulta corrida acessivel ao perfil', security: bearerSecurity,
        responses: { '200': { description: 'Detalhes da corrida' }, '404': { description: 'Corrida nao encontrada ou sem acesso' } },
      },
    },
    '/corridas/{id}/eventos': {
      parameters: [idParameter],
      get: {
        tags: ['Corridas'], summary: 'Lista o historico de eventos da corrida', security: bearerSecurity,
        responses: { '200': { description: 'Eventos paginados' } },
      },
    },
    '/corridas/{id}/localizacoes': {
      parameters: [idParameter],
      get: {
        tags: ['Localizacoes'], summary: 'Lista posicoes da corrida dentro do escopo autenticado',
        security: bearerSecurity,
        parameters: [
          { name: 'pagina', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limite', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        ],
        responses: { '200': { description: 'Posicoes paginadas, mais recentes primeiro' }, '404': { description: 'Corrida sem acesso' } },
      },
      post: {
        tags: ['Localizacoes'], summary: 'Registra a posicao do prestador durante corrida ativa',
        description: 'Exclusivo ao PRESTADOR vinculado. Aceito apenas de ACEITA ate EM_CORRIDA.',
        security: bearerSecurity,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalizacaoInput' } } },
        },
        responses: {
          '201': { description: 'Posicao persistida e publicada via Socket.IO' },
          '403': { description: 'Prestador nao vinculado' },
          '409': { description: 'Corrida fora dos estados de rastreamento' },
          '429': { description: 'Limite de envio excedido' },
        },
      },
    },
    '/corridas/{id}/atribuir': rideAction('Atribui ou altera o prestador', 'GESTOR'),
    '/corridas/{id}/reabrir': rideAction('Reabre corrida recusada', 'GESTOR'),
    '/corridas/{id}/aceitar': rideAction('Aceita ou reivindica corrida disponivel', 'PRESTADOR'),
    '/corridas/{id}/recusar': rideAction('Recusa corrida ofertada', 'PRESTADOR'),
    '/corridas/{id}/iniciar-deslocamento': rideAction('Inicia deslocamento ao embarque', 'PRESTADOR'),
    '/corridas/{id}/cheguei-embarque': rideAction('Confirma chegada ao embarque', 'PRESTADOR'),
    '/corridas/{id}/confirmar-embarque': rideAction('Confirma embarque e inicia corrida', 'PRESTADOR'),
    '/corridas/{id}/confirmar-desembarque': rideAction('Confirma desembarque do passageiro', 'PRESTADOR'),
    '/corridas/{id}/finalizar': rideAction('Finaliza corrida e informa valor final', 'PRESTADOR'),
    '/corridas/{id}/cancelar': rideAction('Cancela corrida com motivo', 'GERENTE e GESTOR'),
    '/prestadores/minha-disponibilidade': {
      patch: {
        tags: ['Corridas'], summary: 'Altera a disponibilidade do prestador autenticado',
        security: bearerSecurity,
        responses: { '200': { description: 'Disponibilidade atualizada' }, '409': { description: 'Prestador possui corrida ativa' } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      masterBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token exclusivo do portal master.' },
    },
    schemas: {
      PrestadorUnificadoCreateInput: {
        type: 'object', additionalProperties: false, required: ['acesso', 'prestador', 'veiculo'],
        properties: {
          acesso: {
            type: 'object', additionalProperties: false,
            required: ['nome', 'email', 'ativo', 'formaAtivacao', 'senha'],
            properties: {
              nome: { type: 'string', minLength: 2, maxLength: 150 }, email: { type: 'string', format: 'email' },
              telefone: { type: ['string', 'null'], maxLength: 20 }, ativo: { type: 'boolean' },
              formaAtivacao: { type: 'string', enum: ['SENHA_TEMPORARIA'] },
              senha: { type: 'string', format: 'password', minLength: 12, maxLength: 128 },
            },
          },
          prestador: {
            type: 'object', additionalProperties: false,
            required: ['reutilizarDadosAcesso', 'cpf', 'numeroCnh', 'validadeCnh', 'disponivel', 'ativo'],
            properties: {
              reutilizarDadosAcesso: { type: 'boolean' }, nome: { type: 'string', minLength: 2, maxLength: 150 },
              cpf: { type: 'string' }, telefone: { type: 'string', maxLength: 20 }, email: { type: ['string', 'null'], format: 'email' },
              numeroCnh: { type: 'string' }, validadeCnh: { type: 'string', format: 'date' },
              disponivel: { type: 'boolean' }, ativo: { type: 'boolean' },
            },
          },
          veiculo: {
            oneOf: [
              { type: 'object', required: ['modo', 'dados'], properties: { modo: { const: 'NOVO' }, dados: { $ref: '#/components/schemas/VeiculoUnificadoInput' } } },
              { type: 'object', required: ['modo', 'veiculoId'], properties: { modo: { const: 'EXISTENTE' }, veiculoId: { type: 'string', format: 'uuid' } } },
              { type: 'object', required: ['modo'], properties: { modo: { const: 'DEPOIS' } } },
            ],
          },
        },
      },
      PrestadorUnificadoUpdateInput: {
        type: 'object', minProperties: 1, additionalProperties: false,
        description: 'Aceita blocos parciais de acesso e prestador e uma acao de veiculo: MANTER, NOVO, EXISTENTE ou DESVINCULAR.',
        properties: {
          acesso: { type: 'object' }, prestador: { type: 'object' },
          veiculo: { type: 'object', required: ['acao'], properties: { acao: { type: 'string', enum: ['MANTER', 'NOVO', 'EXISTENTE', 'DESVINCULAR'] } } },
        },
      },
      VeiculoUnificadoInput: {
        type: 'object', additionalProperties: false,
        required: ['placa', 'marca', 'modelo', 'cor', 'ano', 'capacidadePassageiros', 'ativo'],
        properties: {
          placa: { type: 'string' }, marca: { type: 'string' }, modelo: { type: 'string' }, cor: { type: 'string' },
          ano: { type: 'integer', minimum: 1900 }, capacidadePassageiros: { type: 'integer', minimum: 1 }, ativo: { type: 'boolean' },
        },
      },
      FuncionarioUnificadoCreateInput: {
        type: 'object', additionalProperties: false, required: ['acesso', 'funcionario'],
        properties: {
          acesso: {
            type: 'object', additionalProperties: false, required: ['senha'],
            properties: { senha: { type: 'string', format: 'password', minLength: 12, maxLength: 128 }, ativo: { type: 'boolean', default: true } },
          },
          funcionario: { $ref: '#/components/schemas/FuncionarioUnificadoInput' },
        },
      },
      FuncionarioUnificadoUpdateInput: {
        type: 'object', minProperties: 1, additionalProperties: false,
        properties: {
          acesso: { type: 'object', properties: { senha: { type: 'string', format: 'password', minLength: 12, maxLength: 128 }, ativo: { type: 'boolean' } } },
          funcionario: { type: 'object', description: 'Campos parciais de FuncionarioUnificadoInput, incluindo ativo.' },
        },
      },
      FuncionarioUnificadoInput: {
        type: 'object', additionalProperties: false,
        required: ['centroCustoId', 'nome', 'matricula', 'email'],
        properties: {
          centroCustoId: { type: 'string', format: 'uuid' }, nome: { type: 'string', minLength: 2, maxLength: 150 },
          matricula: { type: 'string', minLength: 1, maxLength: 50 }, cpf: { type: ['string', 'null'] },
          telefone: { type: ['string', 'null'], maxLength: 20 }, email: { type: 'string', format: 'email' },
          enderecoPadrao: { type: ['string', 'null'] }, latitudePadrao: { type: ['number', 'null'], minimum: -90, maximum: 90 },
          longitudePadrao: { type: ['number', 'null'], minimum: -180, maximum: 180 },
        },
      },
      ProvisionamentoInput: {
        type: 'object', additionalProperties: false, required: ['empresa', 'gestor'],
        properties: {
          empresa: {
            type: 'object', additionalProperties: false,
            required: ['codigoAcesso', 'razaoSocial', 'nomeFantasia'],
            properties: {
              codigoAcesso: { type: 'string', minLength: 2, maxLength: 50, example: 'ADM-BR' },
              razaoSocial: { type: 'string', minLength: 2, maxLength: 200 },
              nomeFantasia: { type: 'string', minLength: 2, maxLength: 150 },
              cnpj: { type: ['string', 'null'], pattern: '^[0-9]{14}$' },
              telefone: { type: ['string', 'null'], maxLength: 20 },
              email: { type: ['string', 'null'], format: 'email' },
            },
          },
          gestor: {
            type: 'object', additionalProperties: false, required: ['nome', 'email', 'senha'],
            properties: {
              nome: { type: 'string', minLength: 2, maxLength: 150 },
              email: { type: 'string', format: 'email' },
              telefone: { type: ['string', 'null'], maxLength: 20 },
              senha: { type: 'string', format: 'password', minLength: 12, maxLength: 128 },
            },
          },
        },
      },
      LocalizacaoInput: {
        type: 'object',
        additionalProperties: false,
        required: ['latitude', 'longitude'],
        properties: {
          latitude: { type: 'number', minimum: -90, maximum: 90, example: -23.55052 },
          longitude: { type: 'number', minimum: -180, maximum: 180, example: -46.633308 },
          precisaoMetros: { type: ['number', 'null'], minimum: 0, maximum: 10_000 },
          velocidade: { type: ['number', 'null'], minimum: 0, maximum: 150, description: 'Metros por segundo.' },
          direcao: { type: ['number', 'null'], minimum: 0, maximum: 360, description: 'Graus.' },
        },
      },
    },
  },
} as const;
