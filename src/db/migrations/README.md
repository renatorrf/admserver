# Migrations

O runner ordena os arquivos pelo prefixo numerico, registra checksum em `admtaxi.schema_migrations`
e usa transacao e advisory lock. Consulte o estado com `npm run migrate:status`.

Migrations deste complemento:

- `016_contas_gestor`: credencial unica de gestor e vinculos empresariais, preservando usuarios
  locais e FKs. Nao mescla emails iguais. Aplicada no banco remoto em 19/10/2026 com autorizacao explicita.
- `017_custos_por_passageiro`: centro e valor por participante, consulta financeira individual
  e composicao congelada do faturamento. Preserva a alocacao historica, sem rateio retroativo.
  Aplicada no banco remoto em 19/10/2026 com autorizacao especifica, apos testes isolados
  e validacao no banco remoto com rollback completo. Status final: 001 a 017 aplicadas.

- `010_faturamento_valor_final`: faturamentos, itens congelados, exclusoes justificadas e ajustes
  auditaveis do valor final.
- `011_web_push_vapid`: regiao operacional do prestador, inscricoes Web Push e tentativas por
  dispositivo; preserva as tabelas FCM legadas sem converter ou excluir dados.
- `012_corrida_paradas`: itinerario ordenado com embarques de funcionarios adicionais e paradas
  manuais georreferenciadas.
- `013_itinerario_individual`: versao, paradas estaveis, participacoes individuais e chaves de
  idempotencia. Historicos permanecem com versao zero. Status remoto confirmado como aplicada em 19/10/2026.
  O down recusa exclusao destrutiva; consultar, a partir da raiz do backend,
  `../docs/revisao-geral/MIGRACAO_E_COMPATIBILIDADE.md`.

As migrations `010` e `011` foram aplicadas ao banco remoto em 14/08/2026, na ordem, apos
autorizacao explicita. O runner registrou os checksums e a inspecao posterior confirmou as novas
tabelas, constraints, indices e o enum `status_faturamento`.
