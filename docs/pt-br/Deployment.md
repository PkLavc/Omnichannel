# Deployment

O Compose incluído é destinado a desenvolvimento e homologação controlada. O comando padrão não inicia Ollama:

```powershell
docker compose up --build -d
```

## Checklist para produção

- Guardar segredos fortes do banco, Gateway, Admin, n8n e Chatwoot fora do código.
- Manter a chave de criptografia do Gateway estável e com backup.
- Manter as API keys globais dos providers cifradas no PostgreSQL; revisar cada uma das múltiplas configurações por nome, tipo, prioridade, escopo `ALL` ou relações `SELECTED`, sem incorporá-las ao Admin estático, Cloudflare Pages ou qualquer bundle frontend.
- Publicar Chatwoot, Admin e Gateway atrás de TLS e proxy autenticado.
- Para Cloudflare, usar um domínio gerenciado e um Named Tunnel com hostname estável. Cloudflare Pages hospeda o Nexus estático, mas não alcança o `localhost` da máquina; Quick Tunnels servem apenas para testes e mudam de endereço.
- Não expor PostgreSQL, Redis ou a instância Ollama opcional.
- Usar o login centralizado do Nexus para o Admin, proteger a própria conta Nexus com controles adequados e revisar periodicamente `omnichannelAccess` e as empresas de cada usuário. Manter `ADMIN_TOKEN` somente no secret manager do backend, nunca em URL ou frontend.
- Não confundir o link protegido com SSO do Chatwoot. Na edição Community, o Chatwoot mantém autenticação própria; SSO obrigatório requer uma edição/recurso compatível ou a adoção planejada de um provedor OAuth comum.
- Exigir `X-Tenant-Id` do `PLATFORM_ADMIN` em toda rota tenant-scoped e nunca tratar o header isoladamente como autorização.
- Manter `COMMERCIAL_EVENTS_TOKEN` somente no secret manager do backend; entregar às integrações apenas os tokens derivados por tenant.
- Manter um segredo de webhook por tenant, usar a rota canônica estável com ID opaco, preservar a compatibilidade de slug, rotacionar quando necessário, usar HTTPS e impedir que proxies registrem segredos.
- Implantar backup e restauração testados para PostgreSQL e volumes persistentes.
- Executar testes de isolamento entre pelo menos dois tenants antes de cada release.
- Centralizar logs, métricas, tracing e alertas de provider, RAG, Tool e entrega.

## Escalabilidade

Uma instância do Gateway processa conversas diferentes em paralelo e serializa localmente cada conversa. Múltiplas réplicas exigem fila distribuída, lock e coordenação de idempotência. Um reinício pode interromper uma tarefa que já retornou HTTP `202`.

O profile `local-ai` é uma opção futura. Ele exige download explícito de modelos e planejamento separado de CPU/GPU, armazenamento e rede privada.
