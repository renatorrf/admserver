# Administracao da plataforma

O portal master fica em `/master` no frontend e usa autenticacao separada dos usuarios de empresa.
Tokens master possuem emissor e audiencia proprios e nao sao aceitos nas rotas empresariais.

## Primeiro acesso

O primeiro administrador e criado uma unica vez pelo bootstrap com senha armazenada como hash
Argon2id. A senha deve ser alterada antes de acessar empresas ou outros administradores. Depois da
criacao, o hash de bootstrap e removido do `.env`.

## Operacoes

- Login e consulta da sessao master.
- Troca obrigatoria e posterior alteracao da propria senha.
- Listagem de empresas e quantidade de usuarios.
- Criacao transacional de empresa e primeiro usuario `GESTOR`.
- Listagem e criacao de administradores master.
- Inativacao e reativacao de administradores, com auto-inativacao bloqueada.

Criacoes e alteracoes sao registradas em `auditoria_plataforma`. Respostas e auditorias nunca
incluem senha ou hash. Nao existe exclusao fisica de administradores.

## Seguranca operacional

- Nao reutilize credenciais empresariais no portal master.
- Mantenha apenas os administradores necessarios e inative acessos sem uso.
- Use HTTPS e um gerenciador de segredos fora de desenvolvimento.
- Revise `auditoria_plataforma` periodicamente.
- A sessao master expira em uma hora e nao possui refresh token persistente.
