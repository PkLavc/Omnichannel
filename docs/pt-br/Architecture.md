# Arquitetura

O Chatwoot é a interface omnichannel. O **AI Gateway** recebe eventos, mantém o estado da conversa, aplica prompts e regras de negócio configuráveis, consulta Tools e RAG, seleciona um provider e entrega a resposta pela API do Chatwoot.

```text
Cliente → Chatwoot → webhook → AI Gateway
                                  ├─ memória e regras de negócio
                                  ├─ Tool HTTP registrada
                                  ├─ RAG / pgvector
                                  └─ providers com fallback
                         ← API do Chatwoot ← resposta
```

## Modelo de configuração

O Wizard inicial cria a identidade e a configuração operacional de cada organização. Nome da empresa e do bot, identidade visual, idioma, mensagens, prompts, horário, embeddings, Chatwoot, Tools, conhecimento, regras e conversas são persistidos por tenant.

Providers e suas API keys são globais, e várias configurações do mesmo tipo podem coexistir com nomes únicos. O escopo padrão `ALL` permite o uso por todos os tenants ativos; `SELECTED` exige uma relação explícita em `ProviderTenantAccess`. O compartilhamento termina na capacidade do provider: prompt de Comercial/SAC/pós-venda, RAG, conversa, log e resultado comercial continuam isolados pelo `tenantId`. Veja [Multiempresa e isolamento por tenant](./Multi-Tenancy.md).

Somente segredos de bootstrap e integração permanecem no ambiente: senha do banco, chave de criptografia, credenciais administrativas, a credencial mestra `COMMERCIAL_EVENTS_TOKEN`, chave do n8n e `CHATWOOT_SECRET_KEY_BASE`. A credencial mestra deriva tokens HMAC vinculados ao tenant e nunca é aceita diretamente no endpoint comercial. API keys globais de providers, tokens do Chatwoot e credenciais de Tools são cifrados antes da gravação.

## Identidade administrativa

O Nexus é a fonte de identidade e de escopo de empresas para o acesso cotidiano. Depois de validar sua própria sessão, ele grava no KV apenas o hash de um código aleatório de uso único e redireciona o navegador ao Admin com o código no fragmento da URL. O Admin remove o fragmento imediatamente; o Gateway resgata as claims diretamente no Nexus e emite sua própria sessão curta e revogável. O identificador `jti` também vira a identidade única da sessão no PostgreSQL, impedindo que duas trocas concorrentes reutilizem o mesmo ingresso mesmo diante da consistência eventual do KV.

Identidades Nexus são separadas de identidades locais no banco do Gateway. Empresas autorizadas no Nexus são resolvidas por `Tenant.slug` e viram associações reais `AdminUserTenant`; toda API continua aplicando a autorização existente sobre `X-Tenant-Id`. O `ADMIN_TOKEN` não participa desse fluxo e permanece somente como recuperação de infraestrutura.

## Processamento de mensagens

O webhook canônico `POST /webhooks/chatwoot/:tenantId` usa o ID opaco e estável da empresa, valida o segredo, a conta e uma das inboxes/canais autorizados daquele tenant e aceita eventos `message_created` recebidos, públicos e com conteúdo. O slug atual continua aceito por compatibilidade; a rota sem identificador responde `410` e nunca escolhe uma empresa padrão. A resposta HTTP `202` é imediata para eventos roteados ao tenant, aceitos ou ignorados. Conversas diferentes rodam em paralelo; mensagens da mesma conversa e tenant são serializadas por uma fila em memória. O identificador externo é idempotente dentro do tenant.

A ordem de conhecimento é: Tool habilitada, RAG do tenant e completion de IA sob as regras configuradas contra invenção. Depois da atribuição humana, a mensagem continua registrada, mas nenhuma nova resposta automática é enviada.

## Persistência e serviços

O PostgreSQL mantém bancos separados `gateway`, `chatwoot` e `n8n`. A extensão pgvector é habilitada em `gateway`. O Redis atende ao Chatwoot. Migrations e registros de bootstrap são idempotentes.

O embedding local padrão possui 384 dimensões e funciona sem Ollama. O Ollama é opcional, desabilitado por padrão e só inicia pelo profile Compose `local-ai`.

## Conhecimento opcional do tenant

Arquivos enviados pelo painel são indexados no pgvector somente para o tenant selecionado. As fontes privadas ficam fora do repositório em `<OMNICHANNEL_DATA_ROOT>\tenants\<empresa>`. Não existe planilha nem grafo global: cada arquivo deve ser importado deliberadamente na empresa correta. Um grafo cadastrado no painel é interpretado como conhecimento conversacional somente quando `businessRulesEnabled` está ativo; ele nunca é executado literalmente.

## Limites do MVP

A fila não é distribuída e trabalhos em segundo plano não sobrevivem ao reinício do Gateway. A autorização administrativa valida o usuário e seu acesso ao `X-Tenant-Id`; o header sozinho nunca concede acesso. A revogação de uma conta no Nexus impede novos logins imediatamente, mas uma sessão do Gateway já emitida pode permanecer válida até seu vencimento curto. A edição Community instalada do Chatwoot não oferece SSO nativo com o Nexus e mantém sua própria sessão. Para exposição à internet ainda são necessários HTTPS, rotação de credenciais, revisão periódica das relações usuário/tenant e cuidado para não registrar segredos de webhook.
