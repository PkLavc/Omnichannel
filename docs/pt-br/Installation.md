# Instalação

## Fluxo recomendado no Windows

1. Execute `Omnichannel.bat` e escolha **Iniciar sistema**. Na primeira execução, ele encontra ou cria automaticamente `omnichannel-data` ao lado do repositório, migra qualquer `.env` antigo para `omnichannel-data/config/platform.env`, cria os segredos ausentes, abre o Docker Desktop quando necessário, constrói a stack e aguarda a saúde dos serviços.
2. Guarde o `GATEWAY_ENCRYPTION_KEY` gerado: ele deve permanecer estável depois que credenciais forem salvas. O `ADMIN_TOKEN` também continua em `config/platform.env`, mas somente como segredo técnico de bootstrap e recuperação do backend; o script não o exibe nem o coloca em uma URL.
3. Conclua o onboarding em `http://localhost:3000` e crie as inboxes/canais do Chatwoot que pertencerão à primeira empresa.
4. Entre no Nexus e abra **Comunicação → Configuração da IA**. Se a sessão Nexus estiver válida e o usuário possuir acesso Omnichannel, o login no Admin será concluído automaticamente. Em **Bots / empresas**, crie ou selecione o bot que será configurado.
5. Para uma operação com canais prontos, preencha o Wizard, salve e teste o Chatwoot. Para preparar uma empresa ainda sem canal, mantenha marcada a opção **Começar sem Chatwoot e sem conhecimento**; identidade e prompts ficam editáveis sem criar inbox, webhook ou RAG fictícios.
6. Em **IA e providers / chaves**, cadastre as credenciais globais. O escopo padrão `ALL` atende todas as empresas; use `SELECTED` para uma ou várias empresas específicas. É permitido cadastrar várias credenciais do mesmo tipo com nomes únicos.
7. Selecione a empresa correta e abra **Conhecimento / RAG** para importar manualmente os documentos que pertencem a ela.

Depois do Wizard, as duas configurações ficam no menu lateral do Admin. Em uma instalação multiempresa, o Admin envia o tenant selecionado no header `X-Tenant-Id`; o backend valida se o usuário possui acesso antes de carregar qualquer dado:

- **IA e providers / chaves**: administradores autorizados habilitam providers globais, informam credenciais, escolhem escopo `ALL` ou `SELECTED`, ordenam o fallback, salvam e testam;
- **Conhecimento / RAG**: importe a planilha ou outro documento somente no tenant selecionado, indexe e acompanhe chunks, embeddings e status;
- **Identidade**, **Operação / regras** e **Chatwoot**: configure por empresa os prompts de Comercial, SAC/suporte e pós-venda, as regras e a lista de inboxes/canais.

O onboarding não copia automaticamente nenhum arquivo da pasta privada para tenants novos. A importação é sempre manual em **Conhecimento / RAG**, evitando que a base de uma empresa seja indexada em outra.

O seletor **Bot / empresa ativa** define todo o contexto editado no painel. A área **Identidade** altera nome, marca e mensagens daquele bot; **IA e providers / chaves** altera os prompts somente da empresa selecionada. As proteções comuns usam apenas o nome e as fontes do tenant ativo.

As chaves de IA cadastradas no painel são cifradas no PostgreSQL e continuam salvas após reiniciar. Não é necessário copiá-las para o repositório. `omnichannel-data/config/platform.env` guarda os segredos da infraestrutura e precisa conservar a mesma `GATEWAY_ENCRYPTION_KEY`.

## Acesso centralizado pelo Nexus

O fluxo normal nunca pede `ADMIN_TOKEN`, senha local do Gateway nem credencial de provider. O Nexus gera um código aleatório de uso único, válido por no máximo 60 segundos. O Gateway troca esse código diretamente com o backend do Nexus, cria ou atualiza a identidade vinculada e emite uma sessão revogável limitada às empresas liberadas no cadastro do usuário. O código viaja somente no fragmento da URL e é removido antes da troca.

No Nexus, **Usuários cadastrados** controla se o usuário possui acesso Omnichannel e a quais empresas ele pode acessar. Usuários sem essa liberação não recebem sessão do Gateway. O `ADMIN_TOKEN` permanece disponível apenas dentro da seção recolhida **Acesso técnico / recuperação** do Admin local.

O botão **Atendimento Chatwoot** também fica centralizado no Nexus e exige uma sessão Nexus autorizada para revelar o destino ativo. A edição Community do Chatwoot usada pelo Compose, porém, não fornece SSO nativo com o Nexus: na primeira abertura, o operador ainda precisa autenticar-se no próprio Chatwoot. Uma sessão Chatwoot já existente é reaproveitada normalmente.

No fluxo manual, copie antes `.env.example` para `<OMNICHANNEL_DATA_ROOT>/config/platform.env`, substitua todos os valores `replace-with-*` e mantenha a chave de criptografia estável:

```powershell
docker compose up --build -d
docker compose ps -a
Invoke-RestMethod http://localhost:3001/health
```

Os serviços de execução única `postgres-init`, `gateway-migrate` e `chatwoot-migrate` devem encerrar com código `0`. Os serviços contínuos devem ficar saudáveis ou em execução.

## Endereços locais

- Chatwoot: `http://localhost:3000`
- AI Gateway: `http://localhost:3001/health`
- Admin: `http://localhost:3002`
- n8n: `http://localhost:5678`

## Webhook do Chatwoot

Após o onboarding, configure no Admin a URL interna, conta, lista de inboxes/canais, token de API, equipe padrão e as rotas opcionais de Comercial, SAC/Suporte e Pós-venda. Cada plataforma precisa de uma inbox técnica própria no Chatwoot, mas todas as Inbox IDs daquela empresa ficam na mesma configuração e aparecem ao atendente na operação unificada. Ao salvar e testar, o Gateway cria ou atualiza automaticamente o webhook `AI Gateway`, assina `message_created` e protege a URL com um segredo aleatório cifrado por tenant. A URL base interna é:

```text
http://gateway:3001/webhooks/chatwoot/ID_OPACO_DO_TENANT
```

O ID opaco permanece estável mesmo quando o nome ou slug da empresa muda. O slug atual continua aceito como compatibilidade, mas o teste registra e reconcilia a URL canônica por ID. O segredo daquela empresa autentica o evento, e a conta e uma das inboxes/canais cadastrados também precisam corresponder. A rota sem identificador é recusada: o Gateway nunca escolhe `DEFAULT_TENANT` para uma mensagem. Não copie o segredo da URL nem cadastre um segundo webhook manualmente. Em produção, publique o endpoint por HTTPS e evite registrar segredos em proxies.

A URL `http://gateway:3001` é interna à rede Docker e é a configuração correta enquanto Chatwoot e Gateway rodam no mesmo Compose. Um site do Cloudflare Pages não consegue encaminhar requisições para o `localhost` da sua máquina. Para operação remota, publique Chatwoot e Gateway por HTTPS com um domínio e Cloudflare Tunnel estáveis; não use Quick Tunnel como endereço permanente.

## Token para eventos comerciais

`COMMERCIAL_EVENTS_TOKEN` em `config/platform.env` é somente a credencial mestra do Gateway e nunca deve ser entregue à integração. Com a empresa selecionada, um `PLATFORM_ADMIN` obtém o token derivado:

```http
GET /admin/integrations/commercial-events-token
Authorization: Bearer CREDENCIAL_ADMINISTRATIVA
X-Tenant-Id: ID_OPACO_DO_TENANT
```

O ERP ou gateway de pagamento usa o campo `token` retornado em `POST /v1/commercial/events`, sempre com o mesmo `X-Tenant-Id`. Uma credencial derivada de uma empresa é recusada nas demais.

## Comandos e testes

```powershell
npm ci
npm test -w @omnichannel/gateway
docker compose config --quiet
```

Use o menu único `Omnichannel.bat` para iniciar, parar, reiniciar, atualizar e realizar as configurações auxiliares. Ollama não é requisito e não inicia no comando padrão.
