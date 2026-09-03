# Multiempresa e isolamento por tenant

A plataforma usa um único Gateway e um único painel para atender várias empresas. O compartilhamento é deliberadamente restrito:

- configurações e chaves de providers são globais, com acesso controlado por escopo;
- identidade, Chatwoot, RAG, regras, prompts, conversas, logs e dados comerciais continuam privados por tenant;
- um usuário administrativo somente pode selecionar tenants aos quais recebeu acesso explícito.

`ALL` significa compartilhamento de capacidade de IA, não compartilhamento de dados empresariais.

## Identificadores

Cada tenant possui:

- um ID opaco, usado pelo Admin e pelas APIs autenticadas no header `X-Tenant-Id`;
- um slug legível e mutável, mantido como rota de compatibilidade do webhook do Chatwoot;
- estado ativo ou inativo;
- configurações, relações e credenciais próprias quando o recurso é isolado.

## Cadastro inicial de bot

No painel, **Bots / empresas** é a apresentação administrativa dos tenants. O nome da empresa e o nome do bot são campos distintos, e o seletor superior mostra os dois. O cadastro pode iniciar sem integrações:

```http
POST /admin/tenants
Content-Type: application/json

{
  "name": "Empresa Alpha",
  "botName": "Atendimento Alpha",
  "slug": "empresa-alpha",
  "deferIntegrations": true
}
```

`deferIntegrations: true` apenas evita que o Wizard obrigatório seja aberto antes de existirem canais. O Gateway cria identidade e prompts vazios para o novo tenant, mantém regras e Tools desabilitadas e não cria Chatwoot, webhook, documento ou chunk. Providers com escopo `ALL` ficam disponíveis como capacidade compartilhada; um provider `SELECTED` ainda exige associação explícita.

O mesmo campo pode ser enviado em `PUT /admin/tenants/:id`. A operação altera nome, bot e estado de onboarding, preservando os dados existentes do tenant. Uma instalação limpa não possui tenant técnico ou padrão; a primeira empresa real é cadastrada por `POST`.

O prompt base recebe a empresa selecionada dinamicamente. Escopo comercial, produtos, políticas e tom precisam vir dos prompts, regras, Tools ou RAG daquele tenant; instruções de um tenant nunca são reutilizadas em outro.

Não derive IDs, não use nome da empresa como autorização e não aceite um slug do navegador no lugar do ID opaco.

## Resolução e autorização

### Admin e APIs administrativas

Uma chamada tenant-aware usa:

```http
Authorization: Bearer CREDENCIAL_ADMINISTRATIVA
X-Tenant-Id: ID_OPACO_DO_TENANT
```

O header seleciona o contexto, mas não concede acesso. O `AdminAuthService` primeiro autentica o usuário e depois confirma sua relação com o tenant.

O `PLATFORM_ADMIN` precisa enviar `X-Tenant-Id` em toda rota tenant-scoped; o backend não cai silenciosamente em `DEFAULT_TENANT`. Para um `TENANT_USER` com exatamente uma associação ativa, a API pode inferir essa única empresa quando o header não é enviado. Se houver duas ou mais associações, o header também é obrigatório. O Admin envia o header explicitamente em ambos os casos.

Um ID desconhecido, inativo ou fora da lista autorizada é negado por padrão.

Rotas de administração global de providers exigem permissão administrativa global; estar autorizado em um tenant não autoriza alterar uma chave compartilhada.

### Eventos comerciais

`COMMERCIAL_EVENTS_TOKEN` é uma credencial mestra do backend. Ela nunca é aceita diretamente por `POST /v1/commercial/events` e não deve ser entregue a ERP, gateway de pagamentos ou automação.

Um `PLATFORM_ADMIN` obtém a credencial derivada da empresa selecionada:

```http
GET /admin/integrations/commercial-events-token
Authorization: Bearer CREDENCIAL_ADMINISTRATIVA
X-Tenant-Id: ID_OPACO_DO_TENANT
```

O retorno contém um token determinístico, assinado por HMAC e vinculado ao ID do tenant. A integração usa esse valor junto do mesmo header:

```http
POST /v1/commercial/events
Authorization: Bearer commercial.v1.ID_OPACO_DO_TENANT.ASSINATURA
X-Tenant-Id: ID_OPACO_DO_TENANT
```

Um token derivado para A falha com `X-Tenant-Id: B`, não concede acesso ao Admin e só pode localizar conversas e criar pedidos, pagamentos ou resultados dentro de A. Rotacionar a credencial mestra invalida todos os tokens derivados.

### Webhook do Chatwoot

A rota canônica é:

```text
POST /webhooks/chatwoot/:tenantId
```

O teste de conexão registra uma URL baseada no ID opaco e imutável do tenant. Assim, renomear a empresa ou alterar seu slug não interrompe o webhook. O Gateway valida o segredo, a conta e uma das inboxes autorizadas daquele tenant antes de ler ou gravar a conversa.

Cada canal do Chatwoot possui sua própria inbox técnica: WhatsApp, Instagram, Facebook, Website e API não podem ocupar fisicamente a mesma inbox. No Admin, cada empresa cadastra a conta do Chatwoot e a lista de todas essas Inbox IDs. O Gateway trata a lista como uma única operação, responde sempre na conversa e no canal de origem e continua isolando os dados pelo tenant. O cliente não escolhe tenant: o canal que recebeu a mensagem determina a inbox, e o webhook previamente registrado determina a empresa. Eventos de outra conta ou inbox são ignorados.

Setor e plataforma são conceitos diferentes. O painel permite mapear `commercial`, `support` e `postSale` para equipes e responsáveis do Chatwoot. O Gateway detecta somente sinais explícitos, persiste o setor na memória da conversa e usa a rota específica quando ocorre transferência humana; a equipe e o responsável padrão permanecem como fallback. Assim, agentes trabalham em Comercial, SAC/Suporte ou Pós-venda sem duplicar a operação por plataforma.

O mesmo handler ainda reconhece o slug atual e nomes de webhook legados para compatibilidade e os reconcilia no próximo teste. A rota sem identificador `POST /webhooks/chatwoot` responde `410 tenant_route_required`; ela nunca escolhe `DEFAULT_TENANT`.

## Providers globais

Cada registro de provider é uma configuração global com nome único. Vários registros do mesmo tipo podem coexistir, inclusive com chaves, modelos, prioridades e escopos diferentes. Isso permite, por exemplo, uma credencial Cloudflare compartilhada e outra restrita à Empresa Alpha.

Modelo, endpoint, prioridade, timeout, custos e API key pertencem ao registro global; não existe cópia ou override dentro do tenant.

O `ProviderAccessService` filtra os providers antes do fallback:

| Escopo | Regra |
| --- | --- |
| `ALL` | Disponível para todo tenant ativo. |
| `SELECTED` | Disponível somente para tenants presentes em `ProviderTenantAccess`. Sem relação explícita, o acesso é negado. |

Além do escopo:

- provider desabilitado nunca participa;
- tenant inativo nunca recebe provider, inclusive em `ALL`;
- somente providers acessíveis entram na sequência de prioridade e fallback;
- ausência de provider acessível causa falha explícita, nunca empréstimo de credencial de outro tenant;
- a chave cifrada nunca é retornada para usuários ou para o frontend;
- uso, custo e logs continuam atribuídos ao tenant que realizou a chamada.

Se mais de uma configuração do mesmo tipo estiver acessível ao tenant, todas entram na ordenação global de prioridade. Não existe precedência entre uma configuração local e uma global porque configurações locais de provider não fazem parte desta etapa.

## Dados isolados

| Domínio | Isolamento exigido |
| --- | --- |
| Identidade e configurações | Nome, marca, mensagens, horário, Tools e preferências pertencem ao tenant. |
| Chatwoot | URL, conta, lista de inboxes/canais, token, segredo do webhook, equipe e responsável são exclusivos do tenant. |
| RAG | Documentos, chunks, embeddings, versão do corpus e cache semântico sempre incluem `tenantId`. |
| Regras de negócio | Regras conversacionais e interpretação do `bot.json` são carregadas no contexto do tenant. |
| Prompts | Identidade do bot e instruções de Comercial, SAC/suporte e pós-venda, além de versões, aprovações, comparações, canários e rollback, pertencem ao tenant. |
| Conversas e memória | IDs externos só são únicos dentro do tenant; mensagens, estado e resumo não atravessam a fronteira. |
| Comercial | Resultados, pedidos, pagamentos, feedbacks, avaliações e datasets são filtrados pelo tenant. |
| Observabilidade | Logs, custos, fontes RAG, provider e versão de prompt permanecem atribuídos ao tenant. |

Um índice físico compartilhado, como HNSW, não muda o isolamento lógico: a consulta ao pgvector e ao cache exige o `tenantId`.

## Usuários e troca de empresa

O acesso de usuário é uma relação explícita com tenants. Ao trocar de empresa no Admin:

1. o frontend envia o ID opaco em `X-Tenant-Id`;
2. o backend valida novamente a associação;
3. consultas e mutações passam a usar somente esse tenant;
4. dados da empresa anterior são descartados do estado da tela.

Alterar manualmente o header não amplia permissões. O backend não confia em tenant enviado dentro do corpo JSON quando o contexto já foi resolvido pelo header.

Papéis atuais:

| Papel | Acesso |
| --- | --- |
| `PLATFORM_ADMIN` | Administração global, usuários, tenants e providers; pode selecionar qualquer tenant ativo. |
| `TENANT_USER` | Leitura e escrita somente nos tenants ativos presentes em `AdminUserTenant`. Exige ao menos uma associação. |

Senhas administrativas usam scrypt e precisam ter ao menos 12 caracteres. Sessões são assinadas, possuem registro persistido apenas por hash, expiração e revogação; alterar a senha ou desativar o usuário revoga sessões existentes.

## Matriz obrigatória de cenários

Esta matriz serve como especificação de testes de resolução e isolamento:

| Cenário | Resultado esperado |
| --- | --- |
| Usuário com acesso a A envia `X-Tenant-Id: A` | Permitido; resposta contém somente dados de A. |
| Usuário com acesso apenas a A envia `X-Tenant-Id: B` | Negado, mesmo que B exista. |
| `PLATFORM_ADMIN` sem header em rota tenant-aware | Negado; não usar `DEFAULT_TENANT`. |
| `TENANT_USER` sem header e com uma única associação ativa | A única associação pode ser inferida. |
| `TENANT_USER` sem header e com múltiplas associações | Negado; exigir seleção explícita. |
| ID desconhecido ou tenant inativo | Negado sem revelar dados de existência ou configuração. |
| Provider habilitado com escopo `ALL`, tenant A ativo | Provider disponível para A. |
| Provider `SELECTED` com relação para A | Provider disponível para A. |
| Provider `SELECTED` sem relação para B | Provider excluído do fallback de B. |
| Provider desabilitado com qualquer escopo | Provider indisponível. |
| Tenant inativo e provider `ALL` | Provider indisponível. |
| RAG de A contém um documento e B consulta termo idêntico | B não recebe documento, cache ou versão de corpus de A. |
| A e B usam o mesmo ID externo de conversa | Duas conversas independentes. |
| Pedido de A referencia conversa interna de B | Negado como inexistente no contexto de A. |
| Webhook `/chatwoot/ID_DE_A` com segredo de A | Permitido se a conta e uma das inboxes autorizadas também corresponderem. |
| Webhook `/chatwoot/ID_DE_A` com segredo de B | Negado; não tentar B. |
| Webhook usando o slug atual de A | Aceito como compatibilidade e reconciliado para a rota por ID no próximo teste. |
| Rota sem ID/slug | Negada com `410`; o Gateway não escolhe empresa padrão. |
| Token comercial derivado para A com `X-Tenant-Id: A` | Evento limitado às conversas e dados comerciais de A. |
| Token comercial derivado para A com `X-Tenant-Id: B` | Negado. |
| Credencial mestra usada diretamente em `/v1/commercial/events` | Negada. |
| Token comercial usado em `/admin/*` | Negado. |
| Usuário de tenant tenta ler chave global | A API retorna apenas estado de configuração, nunca a chave. |

## Invariantes para implementação

- Resolver o tenant uma vez por request e repassar seu ID, em vez de consultar um tenant padrão dentro de cada serviço.
- Toda leitura, atualização, exclusão e upsert de dados isolados inclui `tenantId`.
- IDs de conversa, mensagem, prompt, dataset, pedido e pagamento são validados junto com o tenant.
- `SELECTED` usa allowlist explícita e comportamento default-deny.
- Cache, filas e locks incluem tenant e conversa na chave.
- Logs de segurança registram decisão e identificadores técnicos, mas não segredos.
- Respostas de erro não incluem chaves, tokens, configurações de outro tenant nem uma lista de tenants não autorizados.

## Segurança de credenciais

As API keys globais são cifradas com `GATEWAY_ENCRYPTION_KEY` e persistidas no PostgreSQL. `ALL` ou `SELECTED` controla o uso de cada configuração pelo backend; nenhum dos dois escopos entrega o valor ao tenant.

Não salve chaves no Cloudflare Pages, JavaScript, Git ou headers enviados ao navegador. Em produção, use HTTPS, PostgreSQL com backup e um gerenciador de segredos do backend para `ADMIN_TOKEN`, a credencial mestra `COMMERCIAL_EVENTS_TOKEN`, `GATEWAY_ENCRYPTION_KEY` e credenciais de infraestrutura. Distribua somente o token comercial derivado do tenant correspondente.

## Checklist de validação manual

1. Crie dois tenants ativos, A e B, e dois usuários com acessos diferentes.
2. Cadastre um provider `ALL` e outro — inclusive do mesmo tipo — com `SELECTED` somente para A.
3. Confirme que o fallback de A inclui ambos e o de B inclui apenas o primeiro.
4. Importe conhecimentos diferentes e envie a mesma pergunta para os dois tenants.
5. Configure contas e listas de inboxes diferentes para A e B; valide WhatsApp, Instagram e Website de cada empresa na rota estável com ID e segredo.
6. Crie conversas com o mesmo ID externo e confirme estados independentes.
7. Obtenha o token comercial derivado de A, envie um evento para A e confirme que esse token é recusado para B.
8. Troque o header para um tenant não autorizado e confirme a negação.
