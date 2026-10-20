# Corridas agendadas

Ao criar uma corrida AGENDADA, a API grava na mesma transacao um aviso individual
por funcionario. O envio usa o SMTP existente da recuperacao de senha. Cada mensagem
contem empresa, data/hora (America/Sao_Paulo, identificada como horario de Brasilia),
origem e destino do proprio funcionario, sem dados dos outros passageiros.
O link usa a origem de PASSWORD_RESET_URL e exige login normal no app.

## Publicacao

1. Aplicar a migracao 022 antes de iniciar esta versao do backend.
2. Configurar SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM
   e PASSWORD_RESET_URL no ambiente de execucao. Nao gravar credenciais no repositorio.
3. Publicar backend e frontend. Apenas aplicar a migracao nao ativa o fluxo.
4. Garantir o processamento da fila conforme uma das opcoes abaixo.

O servidor tenta enviar apos a criacao e verifica a fila a cada 30 segundos.
No Cloud Run, isso exige CPU fora das requisicoes (instance-based billing) e pelo
menos uma instancia minima para processamento continuo. Essa configuracao implica
custos e nao e alterada pelo aplicativo.
Referencia: https://docs.cloud.google.com/run/docs/configuring/billing-settings

Alternativamente, configurar um Cloud Run Job com a mesma imagem e ambiente,
comando `node dist/process-scheduled-emails.js`, acionado pelo Cloud Scheduler
(por exemplo, a cada minuto). Localmente, apos `npm run build`, usar
`npm run email:process`. O comando envia emails reais; nao usar como teste em producao.
Cada execucao processa no maximo 200 mensagens elegiveis. Escalar a frequencia
conforme o volume. Nenhum Job ou Scheduler e criado automaticamente.

## Entrega e operacao

- SMTP ausente: a corrida e criada; avisos ficam PENDENTE e ha aviso no log.
- Endereco ausente/invalido no cadastro e sem alternativa no usuario vinculado:
  SEM_EMAIL, sem impedir a corrida. Corrigir o cadastro nao reenvia o aviso antigo.
- SMTP indisponivel: ate cinco tentativas, intervalos de 1, 2, 4 e 8 minutos.
- Apos a quinta falha: FALHOU, requer acompanhamento operacional.
- Corrida cancelada/finalizada/vencida, empresa/funcionario inativo ou participante
  removido antes do envio: IGNORADO.
- Reservas expiradas sao recuperadas depois de dois minutos; SKIP LOCKED e token
  de reserva protegem o processamento concorrente por diferentes instancias.
- Uma chave unica por empresa/corrida/funcionario evita reenfileirar na repeticao
  da criacao. SMTP nao oferece entrega exatamente uma vez: se ele aceitar e a
  confirmacao no banco falhar, pode haver duplicata. Message-ID permanece estavel.
- ENVIADO significa aceito pelo servidor SMTP, nao confirmacao de leitura/caixa de entrada.
- Este aviso retrata a criacao. Alteracoes e cancelamentos posteriores devem ser
  consultados no app; este fluxo nao envia emails de atualizacao ou lembretes.

Monitoramento sem expor destinatarios ou enderecos:

```sql
SELECT status, COUNT(*) AS quantidade, MIN(criado_em) AS mais_antigo
FROM admtaxi.emails_agendamento GROUP BY status ORDER BY status;
SELECT id, corrida_id, status, tentativas, ultimo_erro, proxima_tentativa_em
FROM admtaxi.emails_agendamento
WHERE status IN ('FALHOU','SEM_EMAIL') ORDER BY criado_em DESC;
```

## Aceite

O prestador ve o horario agendado e o horario de liberacao do aceite. O backend
bloqueia o aceite antes de `agendada_para - 1 hora`, inclusive chamadas diretas.
No limite exato de uma hora o aceite ja e permitido. O relogio do servidor decide;
o frontend atualiza a disponibilidade automaticamente enquanto a tela esta ativa.
Corridas imediatas permanecem iguais. Continuam valendo disponibilidade do
prestador, vinculo com a empresa, veiculo e impedimento de outra corrida ativa.
