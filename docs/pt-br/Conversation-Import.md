# Importação histórica de conversas

O importador lê arquivos NDJSON/JSONL em fluxo, inclusive `.gz`. Ele foi desenhado para acervos grandes: somente um lote fica na memória, cada linha possui limite descompactado e o progresso é exibido periodicamente.

## Antes de importar

- mantenha uma cópia imutável do arquivo original;
- coloque exatamente uma conversa JSON por linha — arrays JSON completos não são aceitos;
- escolha o tenant explicitamente; o comando nunca usa uma empresa padrão;
- execute primeiro com `--dry-run`;
- prefira um identificador externo estável para cada conversa e mensagem.

No ambiente Docker, um arquivo salvo na raiz privada em `imports/conversas.jsonl.gz` fica disponível como `/private-data/imports/conversas.jsonl.gz`:

```powershell
docker compose exec gateway node dist/cli/import-conversations.js `
  --tenant empresa-alpha `
  --file /private-data/imports/conversas.jsonl.gz `
  --source chatwoot-export-2026 `
  --dry-run
```

Remova `--dry-run` somente depois de revisar as estatísticas. O processo é idempotente por `tenant + externalId` da conversa e por `conversation + externalId` da mensagem. Mensagens sem ID recebem um ID determinístico baseado em sua posição e conteúdo.

## Formato canônico

```json
{"externalId":"conversation-123","status":"resolved","contactId":"contact-9","messages":[{"externalId":"message-1","role":"user","content":"Quero saber o status do pedido","createdAt":"2026-08-01T10:00:00Z"},{"externalId":"message-2","role":"assistant","content":"Vou consultar.","createdAt":"2026-08-01T10:00:02Z"}]}
```

Também são reconhecidos campos usuais de uma exportação do Chatwoot:

- conversa: `externalId`, `external_id`, `id` ou `display_id`;
- mensagens: `messages`;
- mensagem: `externalId`, `external_id` ou `id`;
- direção: `role`, `message_type` e `sender_type`;
- texto/data: `content`, `text`, `body`, `created_at` ou `timestamp`;
- contato: `contactId`, `customerId`, `sender.id` ou `meta.sender.id`.

O identificador do contato é armazenado somente como hash opaco, sem copiar telefone, e-mail, nome ou outro dado pessoal para `Conversation.state`. Ele permite medir diversidade de clientes sem misturar empresas.

## Resultado comercial

Texto da conversa nunca é usado para inferir venda, perda, desconto ou política comercial. Um resultado final só é importado quando há um objeto explícito, `WON` ou `LOST`, com fonte, verificação e evidência externa:

```json
{"externalId":"conversation-124","messages":[{"externalId":"message-3","role":"user","content":"Obrigado"}],"commercialOutcome":{"status":"WON","source":"erp","verified":true,"order_id":"order-789"}}
```

`PENDING`, valores não verificados e resultados sem evidência são contabilizados como rejeitados. `order_id` cria um vínculo `ORDER` verificado e `payment_id` cria um vínculo `PAYMENT` verificado. Uma `externalReference` genérica somente cria vínculo quando vier acompanhada de `kind: "ORDER"` ou `kind: "PAYMENT"`; referências ambíguas não são escolhidas pelo importador.

Para `WON`, o vínculo verificado recebe o estado coerente `completed`. Para `LOST`, um vínculo só é criado quando o arquivo também fornece `order_status`, `payment_status` ou outro campo explícito de status do vínculo. Sem isso, somente o resultado perdido é preservado. Uma nova execução não recria o mesmo resultado ou vínculo verificado.

## Analisar o acervo importado

Depois da importação, faça primeiro uma simulação. O analisador pagina as conversas, limita a concorrência e ignora por padrão as que já possuem avaliação concluída ou pendente na versão atual:

```powershell
docker compose exec gateway node dist/cli/analyze-conversations.js `
  --tenant empresa-alpha `
  --dry-run `
  --batch-size 100 `
  --concurrency 4
```

Revise as contagens e execute o mesmo comando sem `--dry-run`. Ao terminar as avaliações, ele percorre todas as páginas e consolida os candidatos idempotentes. Use `--max-conversations` para validar uma amostra antes de processar um arquivo grande. Reexecuções não duplicam a avaliação da versão atual; `--include-evaluated` só deve ser usado quando uma reavaliação integral for intencional.

## Segurança e limites

- papéis `system`, `developer` e `tool` vindos do arquivo nunca viram instruções;
- tentativas reconhecidas de substituir o prompt são removidas do texto histórico antes da persistência;
- metadados arbitrários do export não são copiados para o estado operacional;
- linhas inválidas ou acima de `--max-line-mb` são rejeitadas sem serem registradas com seu conteúdo;
- `--max-rejected` interrompe arquivos excessivamente corrompidos;
- nenhum dado cru de cliente é mostrado no progresso ou no resumo final.

Para executar localmente, com `DATABASE_URL` já configurada:

```powershell
npm run conversations:import -w @omnichannel/gateway -- --tenant empresa-alpha --file C:\dados\conversas.jsonl.gz --dry-run
```

Use `--help` para consultar os limites e opções de lote.
