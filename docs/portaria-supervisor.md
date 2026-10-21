# Portaria e Supervisor

## Cadastro e acesso

- O Gestor cria o acesso em **Cadastros > Portaria > Novo cadastro**: nome, e-mail, telefone e senha inicial, conforme as validacoes do cadastro de usuarios.
- A Portaria entra pela opcao **Por empresa**, seleciona sua empresa e informa e-mail e senha. A troca da senha temporaria permanece obrigatoria.
- A primeira tela e **Solicitar corrida**. Apos enviar, o formulario fica livre para uma nova solicitacao, sem abrir detalhes da corrida.
- O menu possui somente **Solicitar corrida**, **Notificacoes** e a acao de sair. Rotas diretas para os demais menus tambem sao bloqueadas.
- A Portaria seleciona funcionarios ativos da propria empresa. Nao pode consultar a lista de corridas, acompanhar mapas, aceitar, iniciar, cancelar ou finalizar corridas, administrar cadastros, consultar relatorios ou faturamento.
- Notificacoes mostra as ultimas 50 mensagens do proprio usuario na empresa autenticada, com atualizacao periodica. O envio push continua dependendo da configuracao VAPID, do suporte do dispositivo e da permissao concedida pelo usuario.
- O Gestor pode editar ou inativar o acesso; a inativacao revoga as sessoes.

## Supervisor

O antigo nome visivel **Gerente** passa a **Supervisor**. O identificador interno `GERENTE`, os cadastros existentes, os setores, os centros de custo autorizados e suas permissoes foram preservados. Integracoes continuam usando `GERENTE`.

## Publicacao

1. Aplicar a migration `023_perfil_portaria` pelo runner de migrations antes de utilizar o novo perfil.
2. Publicar o backend atualizado e depois o frontend.
3. Criar um usuario Portaria em uma empresa de teste e validar login, troca obrigatoria de senha, solicitacao e notificacoes.

A migration apenas acrescenta `PORTARIA` ao enum existente. O runner permite esta operacao idempotente fora de transacao, necessaria para compatibilidade com PostgreSQL 9.6; as demais migrations continuam transacionais. O comando de validacao informa explicitamente que esta migration e validada estaticamente, sem executar o ALTER TYPE no banco. O rollback automatico de remocao do perfil e bloqueado para preservar usuarios.

Nenhuma migration remota ou publicacao e realizada pela geracao destes arquivos.

## Verificacao local

- `npm test`: permissoes HTTP, isolamento por empresa/usuario, schemas, criacao e migration mode.
- `node node_modules/tsx/dist/cli.mjs scripts/test-review-integration.ts`: PostgreSQL temporario local, migrations, cadastro real, senha temporaria, idempotencia, notificacoes e inativacao. Nao usa o banco remoto.
- Frontend: testes Angular e `scripts/test-portaria-ui.cjs` com API simulada, menus, rotas bloqueadas e layout em 320, 390 e 1440 px.
