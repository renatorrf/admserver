# Migrations

O runner ordena os arquivos pelo prefixo numerico, registra checksum em `admtaxi.schema_migrations`
e usa transacao e advisory lock. Consulte o estado com `npm run migrate:status`.

Migrations deste complemento:

- `010_faturamento_valor_final`: faturamentos, itens congelados, exclusoes justificadas e ajustes
  auditaveis do valor final.
- `011_web_push_vapid`: regiao operacional do prestador, inscricoes Web Push e tentativas por
  dispositivo; preserva as tabelas FCM legadas sem converter ou excluir dados.

As migrations `010` e `011` foram aplicadas ao banco remoto em 14/08/2026, na ordem, apos
autorizacao explicita. O runner registrou os checksums e a inspecao posterior confirmou as novas
tabelas, constraints, indices e o enum `status_faturamento`.
