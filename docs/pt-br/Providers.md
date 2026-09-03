# Providers de IA

Os adapters nativos implementam o mesmo contrato `AiProvider`, com `health` e `complete`: Cloudflare AI, OpenRouter, Google Gemini e Ollama opcional. O Admin também cadastra providers OpenAI-compatible informando nome, endpoint, caminho de health, API key, modelo, prioridade, timeout e parâmetros de geração.

As configurações e credenciais são globais, mas não existe o limite de uma credencial por tipo. É possível, por exemplo, cadastrar uma credencial Cloudflare compartilhada e outra Cloudflare dedicada a uma empresa, desde que cada configuração tenha um nome único.

O escopo padrão `ALL` libera a configuração para todos os tenants ativos, inclusive empresas criadas depois. `SELECTED` libera somente os tenants associados em `ProviderTenantAccess`; sem associação explícita, o uso é negado. Não existem cópias ou overrides locais dentro do tenant: a seleção acontece entre as configurações globais às quais ele possui acesso.

Chaves são cifradas antes da gravação e nunca retornam pelas APIs administrativas. Para cada tenant, somente providers habilitados e permitidos pelo escopo são tentados por prioridade crescente; falha de health ou completion avança para o próximo provider acessível. Consulte [Multiempresa e isolamento por tenant](./Multi-Tenancy.md).

## Onde cadastrar uma API key

1. Entre no Nexus e abra **Comunicação → Configuração da IA**. O login no Admin será concluído sem expor `ADMIN_TOKEN`; o endereço local `http://localhost:3002` fica como recuperação técnica.
2. No menu lateral, abra **IA e providers / chaves**.
3. Na tabela **Providers, API keys e fallback**, edite uma configuração existente ou crie outra credencial, mesmo que já exista uma do mesmo tipo.
4. Use um nome único, marque a configuração como habilitada e defina prioridade, modelo, Base URL, parâmetros e timeout.
5. Selecione `ALL` — valor padrão — ou `SELECTED`; no segundo caso, informe explicitamente os tenants autorizados.
6. Informe a credencial no campo **API key** e clique em **Salvar**.
7. Clique em **Testar**. O estado deve mudar para `saudável`.

O menor número de prioridade é tentado primeiro. Por exemplo, prioridades `1`, `2` e `3` formam uma sequência principal → primeiro fallback → segundo fallback. Antes disso, o Gateway elimina configurações desabilitadas ou fora do escopo do tenant. Se duas credenciais do mesmo tipo estiverem acessíveis, ambas podem participar conforme a prioridade. O fallback é sequencial: um provider lento só é abandonado quando ultrapassa seu timeout ou retorna uma falha tratável.

Depois de salvar, o campo da chave fica vazio por segurança. Isso não significa que a credencial foi perdida.

### Cloudflare Workers AI

O Cloudflare exige dois valores diferentes:

- um API token com permissões **Workers AI Read** e **Workers AI Edit**;
- o **Account ID**, disponível no dashboard Cloudflare.

Monte a Base URL substituindo o identificador no endereço abaixo:

```text
https://api.cloudflare.com/client/v4/accounts/SEU_ACCOUNT_ID/ai/v1
```

O Account ID faz parte da URL; ele não substitui o token. O exemplo com `SEU_ACCOUNT_ID` é apenas um placeholder e não deve ser salvo ou testado literalmente.

## Onde obter credenciais com faixa gratuita

Use somente os portais oficiais. A chave em si não tem custo; cada provider define cotas, modelos, disponibilidade regional e limites de uso:

- **Cloudflare Workers AI:** crie o token em [API Tokens](https://dash.cloudflare.com/profile/api-tokens) e consulte a [faixa gratuita atual](https://developers.cloudflare.com/workers-ai/platform/pricing/). Configure como prioridade `1`.
- **OpenRouter:** crie uma chave em [OpenRouter Keys](https://openrouter.ai/settings/keys) e use o modelo `openrouter/free`; consulte as [limitações do roteador gratuito](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground). Configure como prioridade `2`.
- **Google Gemini:** crie a chave em [Google AI Studio](https://aistudio.google.com/apikey) e consulte a [documentação de chaves](https://ai.google.dev/gemini-api/docs/api-key) e a cota gratuita do modelo selecionado. Configure como prioridade `3`.

Faixas gratuitas são adequadas para testes e baixo volume, mas podem limitar requisições ou ficar temporariamente indisponíveis. O Gateway usa o próximo provider somente quando a tentativa atual falha ou excede o timeout configurado.

## Persistência e segurança das chaves

As API keys dos providers não precisam ficar em arquivo de ambiente. O Gateway as cifra usando `GATEWAY_ENCRYPTION_KEY` e grava a configuração global no PostgreSQL. O estado portátil em `omnichannel-data` preserva essas credenciais ao parar, reiniciar ou migrar a instalação.

- mantenha `GATEWAY_ENCRYPTION_KEY` estável e com backup; trocá-la impede decifrar credenciais existentes;
- faça backup do PostgreSQL e de seus volumes;
- `docker compose down -v` exclui os volumes locais e, portanto, os dados persistidos;
- nunca grave as chaves no Git, em JavaScript, no HTML do Admin ou em qualquer frontend;
- não salve chaves de IA no Cloudflare Pages: Pages entrega arquivos ao navegador e não é um cofre de segredos;
- em um deployment online, publique o Gateway com PostgreSQL persistente e TLS; o Admin continua enviando a chave somente ao Gateway autenticado.

O arquivo privado `omnichannel-data/config/platform.env` guarda segredos da infraestrutura, como `GATEWAY_ENCRYPTION_KEY`, credenciais do banco e credenciais administrativas. Ele não pertence ao repositório. Um gerenciador de segredos da hospedagem pode fornecer esses valores ao backend em produção, enquanto credenciais globais de providers continuam sendo administradas por usuários autorizados no painel e armazenadas cifradas no banco.

## Testes de conexão

- Cloudflare consulta modelos da conta.
- OpenRouter valida a chave em `/key`.
- Gemini consulta o modelo configurado.
- Ollama consulta `/api/tags` e exige o modelo selecionado.
- Providers OpenAI-compatible usam o health configurado e o contrato `/chat/completions`.

## Uso e custo

O log registra provider, modelo, tentativas de fallback, latência, tokens, Tools, erros e custo estimado, sempre atribuído ao tenant solicitante. O custo vem da API quando disponível ou das tarifas por milhão de tokens configuradas no Admin.

Ollama permanece desabilitado e fora da stack padrão. Uma instância externa pode ser configurada diretamente, ou o serviço opcional pode ser iniciado com `docker compose --profile local-ai up -d ollama`.
