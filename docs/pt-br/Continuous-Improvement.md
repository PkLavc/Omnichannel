# Melhoria contínua controlada

Esta fase transforma conversas reais em sinais auditáveis de qualidade, sem permitir que a IA edite o próprio prompt ou publique mudanças automaticamente. O ciclo implementado é:

```text
conversa
→ resultado comercial e evidência verificável
→ feedback humano e avaliação heurística
→ dataset redigido e versionado
→ versão candidata de prompt
→ comparação e aprovação humana
→ release principal ou canário
→ promoção ou rollback
```

O sistema não treina os modelos dos providers. Ele registra evidências, mede resultados e controla quais versões de prompt podem chegar à produção.

## O que é automático e o que exige aprovação

O Gateway agenda uma avaliação depois de cada resposta válida e consolida automaticamente os sinais em uma taxonomia pequena. Não é criado um card para cada conversa: existe no máximo um card por tática e especialidade (`Triagem`, `Comercial`, `SAC` ou `Técnico`), e uma nova avaliação atualiza a evidência da mesma conversa.

Uma tática comportamental só fica pronta para revisão quando reúne, por padrão, pelo menos 8 conversas, 5 clientes distintos, 3 resultados verificados, 4 evidências favoráveis, confiança de 72% e no máximo 25% de contradição. Repetição sem diversidade ou resultado confirmado permanece em `GATHERING`.

Fatos comerciais, preços, descontos, garantias e políticas nunca são aprendidos das falas. Esses cards permanecem em `BLOCKED_GROUNDING` até receberem uma referência oficial do RAG, regra habilitada ou Tool do mesmo tenant. Mesmo aprovados, eles não injetam o valor visto na conversa: o runtime precisa consultar novamente a fonte oficial.

O humano revisa apenas os cards consolidados em **Melhoria contínua → Candidatos consolidados**. Aprovar uma tática comportamental a ativa somente na especialidade que gerou a evidência; rejeitar preserva a decisão no histórico. Não há geração nem publicação automática de versões de prompt.

Datasets continuam sendo um fluxo separado: feedback `POSITIVE` e `NEGATIVE` vira exemplo `GOOD` e `BAD`, avaliações concluídas usam o corte `0.70`, fingerprints removem duplicatas e padrões comuns de PII são redigidos. A criação, aprovação, canário e rollback de prompts continuam humanos e explícitos.

A API exige `tenant:write` para descobrir, aprovar ou rejeitar candidatos. O revisor real vem da sessão autenticada.

## Onde usar no Admin

1. Entre no Nexus e abra **Comunicação → Configuração da IA**.
2. O Nexus emitirá a sessão administrativa automaticamente; use `ADMIN_TOKEN` somente no fluxo técnico de recuperação.
3. No menu lateral, abra **Melhoria contínua**.
4. Informe o ID externo da conversa ou selecione uma conversa na tabela.

Essa tela reúne:

- resultado comercial;
- vínculo com pedido ou pagamento;
- feedback humano;
- avaliação automática;
- candidatos de aprendizado consolidados, separados por especialidade;
- datasets e versões;
- versões, comparações, aprovações, releases canário e rollback de prompts;
- métricas de resultados, avaliações e cache semântico.

As configurações de modelos e credenciais ficam em **IA e providers / chaves**. Os documentos do RAG ficam em **Conhecimento / RAG**. Provider, latência, tokens, custo e logs ficam em **Operação**.

## Resultado comercial

Cada conversa pode ter revisões sucessivas de resultado. Uma revisão nova preserva a anterior e registra qual versão foi substituída.

| Estado | Significado |
| --- | --- |
| `PENDING` | Ainda não existe evidência conclusiva de ganho ou perda. |
| `WON` | Existe resultado positivo confirmado, normalmente um pedido ou pagamento verificado com status de sucesso. |
| `LOST` | A perda foi confirmada por evidência terminal negativa ou registrada manualmente por um responsável. |

O Admin permite registrar manualmente estado, confiança entre `0` e `1` e evidências. Texto persuasivo, intenção de compra ou uma afirmação da própria IA não devem ser tratados como prova de venda.

### Vínculo com pedido ou pagamento

Um vínculo comercial possui:

- tipo `ORDER` ou `PAYMENT`;
- sistema de origem, como ERP ou gateway de pagamento;
- identificador externo;
- status externo;
- valor e moeda opcionais;
- estado de verificação `UNVERIFIED`, `VERIFIED` ou `REJECTED`;
- evidência de verificação em JSON.

Um vínculo `VERIFIED` ou `REJECTED` exige evidência não vazia. A combinação tenant, tipo, origem e identificador externo é única e não pode ser associada a duas conversas diferentes.

Ao receber ou atualizar um vínculo, o Gateway reconcilia o resultado:

- qualquer vínculo verificado com status como `paid`, `approved`, `captured`, `completed`, `delivered` ou `success` resulta em `WON`;
- se todos os vínculos verificados estiverem em estados terminais como `cancelled`, `declined`, `expired`, `failed`, `refunded` ou `lost`, resulta em `LOST`;
- os demais casos permanecem `PENDING`.

Essa reconciliação ocorre quando o evento é enviado ao Gateway. O Gateway não consulta sozinho um ERP ou gateway de pagamento; o sistema externo deve publicar cada mudança de status.

## Feedback humano

O feedback pode avaliar a conversa inteira ou uma mensagem específica da IA. Ele registra:

- veredito `POSITIVE`, `NEGATIVE` ou `NEUTRAL`;
- nota inteira opcional entre `-100` e `100`;
- comentário;
- resposta esperada;
- identificador do revisor e origem.

Ao materializar um dataset, feedback negativo vira exemplo ruim e feedback positivo vira exemplo bom, mantendo a resposta esperada e a justificativa quando informadas. Feedback neutro permanece auditável, mas não recebe artificialmente um rótulo `GOOD` ou `BAD` e não entra no dataset.

## Avaliador automático

O avaliador atual é `deterministic-conversation-rubric` versão `1.0.0`. Ele é heurístico e determinístico: não chama outro LLM, não gera custo de provider e produz o mesmo resultado para a mesma fotografia de dados.

Ele considera:

| Dimensão | Peso |
| --- | ---: |
| Cobertura das mensagens do cliente | 22% |
| Resultado comercial | 22% |
| Satisfação humana | 18% |
| Evidência do resultado | 14% |
| Engajamento e equilíbrio da conversa | 12% |
| Concisão das respostas | 12% |

A avaliação grava a versão do avaliador, IDs das mensagens, revisão do resultado, quantidade de feedbacks, vínculos verificados, nota final, dimensões, evidências e recomendações.

Ela não verifica sozinha se uma resposta é factualmente correta, não confirma pagamentos e não altera prompts. Suas recomendações são material para revisão humana.

Uma resposta válida do provider agenda a avaliação depois da entrega, fora do caminho crítico do Chatwoot. Falhas operacionais de provider não são atribuídas ao prompt. Resultado comercial, vínculo de pedido/pagamento e feedback humano também disparam uma nova avaliação, para que a nota reflita as evidências mais recentes. Se uma conversa atravessou versões diferentes de prompt, a avaliação da conversa não é creditada a uma única versão.

## Dataset redigido e versionado

**Materializar dataset** cria uma versão `DRAFT` a partir dos feedbacks positivos/negativos e de todas as avaliações concluídas disponíveis. Avaliações com nota maior ou igual a `0.70` recebem `GOOD`; as demais recebem `BAD`. Cada exemplo possui entrada, resposta, resposta esperada, justificativa, origem, fingerprint e rastreabilidade interna.

Antes da persistência do texto reutilizável, o Gateway substitui padrões comuns de:

- e-mail;
- CPF;
- CNPJ;
- número de cartão;
- telefone.

Os valores são substituídos por marcadores como `<EMAIL>` e `<PHONE>`; identificadores brutos ou hashes reversíveis não são usados como substitutos. A relação interna com conversa, feedback ou avaliação é preservada para auditoria.

A redação automática não reconhece todos os nomes próprios, endereços ou identificadores de domínio. Revise os exemplos antes de publicar ou exportar um dataset.

Versões:

- somente uma versão `DRAFT` pode receber exemplos;
- fingerprints eliminam duplicatas dentro da mesma versão;
- o checksum muda de forma determinística conforme os exemplos;
- publicar exige pelo menos um exemplo;
- a nova versão vira `PUBLISHED` e a publicada anteriormente vira `ARCHIVED`;
- versões publicadas não são editadas.

Publicar um dataset não altera o prompt nem o comportamento da IA. Ele passa a ser um artefato versionado e auditável; o avaliador e a comparação de prompts atuais não o consomem automaticamente.

## Prompts: aprovação, canário e rollback

O prompt conversacional versionado é o bundle `assistant-bundle`, composto por:

- `system`;
- `commercial`;
- `support`;
- `postSale`.

O fluxo seguro é:

1. criar uma versão candidata;
2. comparar candidata e base;
3. revisar diferenças e métricas;
4. aprovar explicitamente a versão;
5. publicar como principal ou canário;
6. promover o canário ou executar rollback.

A comparação registra campos alterados, tamanhos e hashes, além da quantidade e média das avaliações já vinculadas a cada versão. Ela não executa, por si só, um novo teste sobre todas as conversas do dataset.

Somente versões `APPROVED` podem participar de um release. Em um canário, um bucket SHA-256 determinístico do tenant, definição do prompt e ID externo da conversa decide a versão. Assim, a mesma conversa continua na mesma variante enquanto o release permanecer ativo.

O endpoint de promoção transforma o canário atual na versão principal. O rollback encerra o release atual e cria outro apontando para uma versão aprovada anterior ou explicitamente selecionada. A tela atual oferece criação, comparação, aprovação, publicação e rollback; promoção explícita do canário está disponível pela API.

A versão escolhida é registrada nas mensagens e nos logs, permitindo relacionar avaliação, resultado e resposta ao prompt usado.

## Desempenho do RAG

O fluxo de consulta continua isolado por tenant:

```text
pergunta
→ embedding
→ cache semântico válido?
→ candidatos pgvector
→ reranker híbrido
→ trechos enviados ao provider ativo ou fallback
```

### Cache semântico

O cache usa tenant, namespace, versão do corpus, parâmetros da busca e fingerprint da configuração de embeddings. Por padrão:

- fica habilitado;
- expira em 15 minutos;
- exige similaridade mínima de `0.96`;
- ignora entradas expiradas;
- remove entradas expiradas ou de versões antigas quando grava uma nova entrada.

Importar, atualizar, reindexar ou excluir conhecimento incrementa a versão do corpus por trigger. Uma entrada de versão anterior nunca é retornada.

A pergunta bruta do cliente não é persistida no cache. São armazenados somente SHA-256 da consulta, embedding, trechos recuperados, métricas de uso e expiração. O `AiLog` registra `cacheHit` e as fontes do RAG utilizadas.

Variáveis opcionais:

| Variável | Padrão | Uso |
| --- | ---: | --- |
| `RAG_CACHE_ENABLED` | `true` | Use `false` para desabilitar o cache. |
| `RAG_CACHE_TTL_SECONDS` | `900` | TTL, limitado entre 30 e 86.400 segundos. |
| `RAG_CACHE_MIN_SCORE` | `0.96` | Similaridade mínima do cache, limitada entre `0.8` e `1`. |
| `RAG_RERANK_CANDIDATE_MULTIPLIER` | `4` | Quantos candidatos recuperar por resultado solicitado, limitado entre `1` e `10`. |

### Reranker

A busca recupera mais candidatos do pgvector e aplica um reranker determinístico. A pontuação combina:

- 72% de similaridade vetorial;
- 28% de cobertura lexical, termos no título, bigramas e frase exata.

Isso favorece códigos, nomes de produtos e termos de política sem abandonar a relevância semântica. Empates preservam a ordem original, tornando o resultado reproduzível.

### HNSW

As embeddings de `KnowledgeDocument` e `SemanticCacheEntry` possuem índices HNSW com distância de cosseno. Se a instalação do pgvector não suportar HNSW, a migration mantém a busca vetorial exata existente em vez de impedir a inicialização.

## Endpoints atuais

Os endpoints administrativos tenant-scoped e `/v1/chat/completions` exigem:

```http
Authorization: Bearer SEU_ADMIN_TOKEN
X-Tenant-Id: ID_OPACO_DO_TENANT
```

Rotas globais, como gestão de tenants, usuários e providers, não usam `X-Tenant-Id`. Já o `PLATFORM_ADMIN` precisa enviar o header em toda rota tenant-scoped.

`COMMERCIAL_EVENTS_TOKEN` no ambiente é uma credencial mestra e nunca é aceita diretamente por `POST /v1/commercial/events`. Um `PLATFORM_ADMIN` obtém primeiro o token derivado para a empresa:

```http
GET /admin/integrations/commercial-events-token
Authorization: Bearer SEU_ADMIN_TOKEN
X-Tenant-Id: ID_OPACO_DO_TENANT
```

A integração usa o campo `token` retornado:

```http
Authorization: Bearer commercial.v1.ID_OPACO_DO_TENANT.ASSINATURA
X-Tenant-Id: ID_OPACO_DO_TENANT
```

A opção **Iniciar sistema** de `Omnichannel.bat` gera a credencial mestra `COMMERCIAL_EVENTS_TOKEN` em `omnichannel-data/config/platform.env` sem alterar segredos existentes. Não reutilize nem distribua o token administrativo ou a credencial mestra em ERP, pagamentos ou automações. O token derivado é assinado por HMAC, funciona somente com o mesmo `X-Tenant-Id` e não concede acesso ao Admin. Rotacionar a credencial mestra invalida todos os tokens derivados.

| Método e caminho | Finalidade |
| --- | --- |
| `GET /admin/integrations/commercial-events-token` | Retorna ao `PLATFORM_ADMIN` a credencial comercial derivada do tenant selecionado. |
| `POST /v1/commercial/events` | Recebe `conversationExternalId` e um evento `ORDER` ou `PAYMENT`, atualiza o vínculo e reconcilia o resultado. |
| `GET /admin/improvement/summary` | Retorna métricas, conversas, resultados, vínculos, feedbacks, avaliações, datasets, prompts e cache. |
| `PUT /admin/conversations/:externalId/outcome` | Cria uma revisão manual `PENDING`, `WON` ou `LOST`. |
| `POST /admin/conversations/:externalId/commerce-links` | Cria ou atualiza pedido/pagamento e reconcilia o resultado. |
| `POST /admin/conversations/:externalId/feedback` | Registra feedback humano da conversa ou mensagem. |
| `POST /admin/conversations/:externalId/evaluate` | Executa e persiste a avaliação heurística. |
| `GET /admin/learning/candidates` | Lista a fila consolidada e as diretrizes aprovadas. |
| `POST /admin/learning/discover` | Consolida novas avaliações sem criar cards por conversa. |
| `POST /admin/learning/candidates/review` | Aprova, rejeita ou reabre candidatos em lote. |
| `POST /admin/learning/candidates/:id/ground` | Vincula e valida fontes oficiais para um fato ou oferta. |
| `POST /admin/datasets/materialize` | Cria uma versão draft e materializa feedbacks e avaliações elegíveis. |
| `POST /admin/datasets/:datasetId/versions/:versionId/publish` | Publica uma versão não vazia e arquiva a anterior. |
| `GET /admin/prompts` | Lista definição, versões, releases, comparações e bundle atual. |
| `POST /admin/prompts/versions` | Cria uma versão candidata do prompt. |
| `POST /admin/prompts/versions/:id/approve` | Aprova uma versão candidata. |
| `POST /admin/prompts/compare` | Registra diff e métricas entre base e candidata. |
| `POST /admin/prompts/release` | Publica release principal ou canário com versões aprovadas. |
| `POST /admin/prompts/promote` | Promove o canário ativo a principal. |
| `POST /admin/prompts/rollback` | Restaura uma versão aprovada anterior ou selecionada. |
| `GET /admin/rag/documents` | Lista documentos, chunks, embeddings e estado de indexação. |
| `POST /admin/rag/import` | Importa e indexa um arquivo aceito. |
| `POST /admin/rag/reindex` | Recria embeddings do tenant ou documento selecionado. |
| `DELETE /admin/rag/documents/:source/:externalId` | Exclui um documento e invalida o corpus. |

Exemplo de evento verificado:

```json
{
  "conversationExternalId": "12345",
  "kind": "PAYMENT",
  "source": "gateway-pagamentos",
  "externalId": "pay_987",
  "status": "paid",
  "value": 199.9,
  "currency": "BRL",
  "verificationStatus": "VERIFIED",
  "verificationEvidence": {
    "transactionId": "pay_987",
    "checkedAt": "2026-07-28T15:00:00Z"
  }
}
```

## Chaves e segurança operacional

No Admin, abra **IA e providers / chaves**, preencha o campo **API key**, salve e teste o provider. A chave:

- é enviada somente ao Gateway autenticado;
- é cifrada com `GATEWAY_ENCRYPTION_KEY`;
- fica em uma configuração global persistida no PostgreSQL; várias configurações do mesmo tipo podem coexistir com nomes e escopos diferentes;
- sobrevive a reinícios e reconstruções sem remoção dos volumes;
- não volta pelas APIs e não é exibida novamente pelo Admin.

Não coloque chaves de providers no Git, no HTML/JavaScript, no Cloudflare Pages ou em outro frontend. Cloudflare Pages publica arquivos para o navegador e não funciona como cofre.

Em produção online:

- hospede o Gateway atrás de HTTPS;
- use PostgreSQL persistente e com backup;
- forneça `ADMIN_TOKEN`, a credencial mestra `COMMERCIAL_EVENTS_TOKEN`, `GATEWAY_ENCRYPTION_KEY` e credenciais do banco por um gerenciador de segredos do backend;
- distribua a cada integração somente o token comercial derivado do tenant correspondente;
- mantenha `GATEWAY_ENCRYPTION_KEY` estável, pois trocá-la impede decifrar as chaves já armazenadas;
- não exponha o `ADMIN_TOKEN` em links, logs ou frontend público.

O Admin mantém o token de sessão somente na memória da página. Recarregar ou fechar a aba exige informá-lo novamente.

## Limites intencionais

- Nenhum modelo é treinado automaticamente.
- Avaliações e datasets não editam nem publicam prompts.
- Uma conversa não prova venda sem evento comercial ou revisão humana.
- O redator de PII reduz risco, mas não substitui revisão de privacidade.
- O cache acelera recuperação; ele não muda a fonte da verdade do RAG.
