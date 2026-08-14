# Matriz de permissoes

Esta matriz registra o controle implementado. O backend e a fonte de autorizacao;
ocultar uma acao no frontend nao substitui a validacao da API.

| Recurso ou acao | PRESTADOR | GERENTE | GESTOR |
| --- | --- | --- | --- |
| Login, refresh, logout e perfil atual | Sim | Sim | Sim |
| Consultar e atualizar empresa atual | Nao | Nao | Sim |
| CRUD logico de usuarios | Nao | Nao | Sim |
| Vincular gerente a centros de custo | Nao | Nao | Sim |
| CRUD logico de prestadores | Nao | Nao | Sim |
| Cadastro unificado de acesso, prestador e veiculo | Nao | Nao | Sim |
| Consultar dispositivos no cadastro unificado | Nao | Nao | Sim |
| CRUD logico de veiculos | Nao | Nao | Sim |
| CRUD logico de centros de custo | Nao | Nao | Sim |
| CRUD logico de funcionarios | Nao | Nao | Sim |
| Consultar auditoria da empresa | Nao | Nao | Sim |
| Listar corridas dentro do proprio escopo | Sim | Sim | Sim |
| Solicitar corrida | Nao | Sim | Sim |
| Atribuir prestador ou reabrir recusa | Nao | Nao | Sim |
| Aceitar, recusar e executar corrida | Sim | Nao | Nao |
| Cancelar SOLICITADA ou OFERTADA | Nao | Sim | Sim |
| Cancelar ACEITA | Nao | Nao | Sim |
| Alterar a propria disponibilidade | Sim | Nao | Nao |
| Enviar localizacao da propria corrida ativa | Sim | Nao | Nao |
| Consultar localizacoes de corrida acessivel | Sim | Sim | Sim |
| Acompanhar corrida acessivel via Socket.IO | Sim | Sim | Sim |
| Excluir fisicamente cadastros | Nao | Nao | Nao |

## Regras transversais

- Todas as consultas administrativas usam o `empresa_id` do access token.
- `empresa_id` e rejeitado em payloads e filtros validados.
- Um gestor nao pode inativar a propria conta nem alterar o proprio perfil.
- Inativar usuario revoga todos os refresh tokens desse usuario.
- Alterar senha ou perfil tambem revoga os refresh tokens existentes.
- Apenas usuario ativo com perfil `GERENTE` pode receber centros de custo.
- Apenas centros de custo ativos da mesma empresa podem ser vinculados.
- Apenas usuario ativo com perfil `PRESTADOR` pode ser vinculado a prestador.
- Inativar prestador tambem remove sua disponibilidade.
- No cadastro unificado, inativar o acesso ou o prestador inativa ambos na mesma transacao,
  remove a disponibilidade e revoga as sessoes do usuario.
- Veiculo existente so pode ser vinculado quando esta ativo, pertence a mesma empresa e esta livre;
  transferencia entre prestadores exige uma operacao explicita e nao ocorre silenciosamente.
- Relacoes atuais de gerente e centro de custo podem ser substituidas fisicamente porque a tabela
  nao possui estado logico; a alteracao completa permanece registrada em auditoria.

- A localizacao so e aceita do prestador vinculado, entre `ACEITA` e `EM_CORRIDA`.
- Gerentes recebem tempo real apenas de corridas pertencentes aos centros de custo autorizados.
- Gestores recebem tempo real apenas da propria empresa.
