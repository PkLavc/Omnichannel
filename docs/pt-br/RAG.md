# RAG

O pipeline é `Loader → Chunker → Embeddings → Retriever → Context Builder`. Os vetores têm 384 dimensões, ficam no pgvector e toda importação ou consulta aplica o escopo do tenant.

## Arquivos de conhecimento

O conhecimento privado fica fora do repositório em `<OMNICHANNEL_DATA_ROOT>\tenants\<empresa>\rag`. O Wizard não copia nem indexa arquivos automaticamente. O operador precisa selecionar a empresa e importar deliberadamente o documento em **Conhecimento / RAG**.

O Admin aceita XLSX, PDF, DOCX, Markdown, TXT e HTML. O texto é extraído, normalizado, dividido em chunks sobrepostos, vetorizado e substituído idempotentemente quando o mesmo documento lógico é importado novamente.

A gestão de RAG lista documentos, quantidades de chunks e embeddings, data de indexação e status. O operador pode excluir, reindexar ou atualizar embeddings sem editar arquivos ou variáveis de ambiente.

## Onde importar e indexar

1. Abra o Admin em `http://localhost:3002` e faça login.
2. Confira a empresa ativa no seletor. Esse tenant receberá o documento.
3. No menu lateral, clique em **Conhecimento / RAG**.
4. Em **Importar documento**, escolha um XLSX, PDF, DOCX, Markdown, TXT ou HTML dentro da pasta privada da empresa.
5. Clique em **Importar e indexar** e aguarde a confirmação.
6. Em **Fontes indexadas**, confirme status `ready` e valores maiores que zero nas colunas de chunks e embeddings.

Importar um arquivo para a Empresa Alpha não o torna visível na Empresa Beta. Documentos, chunks, embeddings, versão do corpus e cache semântico incluem `tenantId`. Para usar o mesmo arquivo em duas empresas, importe-o conscientemente em cada uma.

A indexação fica no PostgreSQL/pgvector persistente e sobrevive a reinícios dos containers. Excluir os volumes com `docker compose down -v` remove esses dados.

Dentro da empresa selecionada, o RAG é compartilhado pela cadeia de providers: o Gateway recupera o contexto antes de escolher a IA. Assim, Cloudflare, OpenRouter, Gemini ou outro fallback recebem os mesmos trechos daquele tenant; não existe uma cópia da base por provider e nunca se consulta a base de outro tenant.

## Embeddings e recuperação

O embedding local padrão é uma representação lexical determinística de 384 dimensões e não exige download. Por tenant, o Admin permite selecionar o adapter opcional Ollama, URL, modelo e timeout.

A recuperação usa similaridade de cosseno no pgvector, limite controlado, filtro de tenant e threshold configurável. O SQL é parametrizado; o conteúdo recuperado é normalizado e filtrado contra padrões básicos de prompt injection antes de entrar no contexto.
