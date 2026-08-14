# Matriz de permissoes

Esta matriz registra o controle implementado. O backend e a fonte de autorizacao;
ocultar uma acao no frontend nao substitui a validacao da API.

| Recurso ou acao | PRESTADOR | FUNCIONARIO | GERENTE | GESTOR |
| --- | --- | --- | --- | --- |
| Login, refresh, logout e perfil atual | Sim | Sim | Sim | Sim |
| Consultar e atualizar empresa atual | Nao | Nao | Nao | Sim |
| CRUD logico de usuarios | Nao | Nao | Nao | Sim |
| Vincular gerente a setores e centros de custo | Nao | Nao | Nao | Sim |
| CRUD logico de prestadores | Nao | Nao | Nao | Sim |
| Cadastro unificado de acesso, prestador e veiculo | Nao | Nao | Nao | Sim |
| Cadastro unificado de acesso e funcionario | Nao | Nao | Nao | Sim |
| Consultar dispositivos no cadastro unificado | Nao | Nao | Nao | Sim |
| CRUD logico de veiculos | Nao | Nao | Nao | Sim |
| CRUD logico de setores | Nao | Nao | Nao | Sim |
| CRUD logico de centros de custo | Nao | Nao | Nao | Sim |
| CRUD logico de funcionarios | Nao | Nao | Nao | Sim |
| Consultar auditoria da empresa | Nao | Nao | Nao | Sim |
| Consultar escopo operacional proprio | Nao | Nao | Sim | Sim |
| Pesquisar funcionarios fora dos centros autorizados | Nao | Nao | Nao | Sim |
| Consultar prestadores presentes nas corridas do escopo | Nao | Nao | Sim | Sim |
| Listar corridas dentro do proprio escopo | Sim | Sim | Sim | Sim |
| Consultar painel individual | Sim | Sim | Nao | Nao |
| Solicitar corrida | Nao | Nao | Sim | Sim |
| Atribuir prestador ou reabrir recusa | Nao | Nao | Nao | Sim |
| Aceitar, recusar e executar corrida | Sim | Nao | Nao | Nao |
| Cancelar SOLICITADA ou OFERTADA | Nao | Nao | Sim | Sim |
| Cancelar ACEITA | Nao | Nao | Nao | Sim |
| Alterar a propria disponibilidade | Sim | Nao | Nao | Nao |
| Enviar localizacao da propria corrida ativa | Sim | Nao | Nao | Nao |
| Consultar localizacoes de corrida acessivel | Sim | Nao | Sim | Sim |
| Acompanhar corrida acessivel via Socket.IO | Sim | Nao | Sim | Sim |
| Gerenciar inscricoes Web Push proprias | Sim | Sim | Sim | Sim |
| Consultar diagnostico Web Push da empresa | Nao | Nao | Nao | Sim |
| Consultar os proprios faturamentos | Sim | Nao | Nao | Sim |
| Resumir, fechar, cancelar e corrigir faturamento | Nao | Nao | Nao | Sim |
| Excluir fisicamente cadastros | Nao | Nao | Nao | Nao |

## Regras transversais

- Todas as consultas administrativas usam o `empresa_id` do access token.
- `empresa_id` e rejeitado em payloads e filtros validados.
- Um gestor nao pode inativar a propria conta nem alterar o proprio perfil.
- Inativar usuario revoga todos os refresh tokens desse usuario.
- Alterar senha ou perfil tambem revoga os refresh tokens existentes.
- Apenas usuario ativo com perfil `GERENTE` pode receber setores e centros de custo.
- O centro vinculado deve estar ativo, pertencer a um setor ativo autorizado e estar na mesma empresa.
- O escopo do gerente e resolvido pelo backend em cada requisicao e nunca e aceito do frontend.
- Um gerente sem setores ou centros possui escopo vazio; nenhum fallback para a empresa inteira e aplicado.
- Detalhes, acoes, dashboard, relatorios, CSV, localizacoes e Socket.IO usam o mesmo escopo.
- Apenas usuario ativo com perfil `PRESTADOR` pode ser vinculado a prestador.
- Inativar prestador tambem remove sua disponibilidade.
- No cadastro unificado, inativar o acesso ou o prestador inativa ambos na mesma transacao,
  remove a disponibilidade e revoga as sessoes do usuario.
- Veiculo existente so pode ser vinculado quando esta ativo, pertence a mesma empresa e esta livre;
  transferencia entre prestadores exige uma operacao explicita e nao ocorre silenciosamente.
- O cadastro unificado de funcionario cria um usuario `FUNCIONARIO` e preenche
  `funcionarios.usuario_id` na mesma transacao. E-mail e senha temporaria sao obrigatorios.
- O perfil `FUNCIONARIO` pode consultar somente corridas vinculadas ao proprio cadastro e o painel
  individual. Nao pode solicitar, cancelar ou acessar custos gerais, auditoria ou outros funcionarios.
- Inativar o funcionario pelo fluxo unificado tambem inativa seu usuario e revoga as sessoes.
- Relacoes atuais de gerente, setor e centro podem ser substituidas fisicamente porque as tabelas
  nao possuem estado logico; os valores anteriores e novos permanecem registrados em auditoria.

- A localizacao so e aceita do prestador vinculado, entre `ACEITA` e `EM_CORRIDA`.
- Gerentes recebem tempo real apenas de corridas pertencentes aos centros de custo autorizados.
- Gestores recebem tempo real apenas da propria empresa.
