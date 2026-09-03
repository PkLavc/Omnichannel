# RAG

The implemented pipeline is `Loader → Chunker → Embeddings → Retriever → Context Builder`. Vectors have 384 dimensions, are stored in pgvector, and every import and query is tenant-scoped.

## Knowledge files

Private knowledge stays outside the repository under `<OMNICHANNEL_DATA_ROOT>\tenants\<company>\rag`. The Wizard does not copy or index files automatically. An operator must select the company and deliberately import the document under **Knowledge / RAG**.

The Admin accepts XLSX, PDF, DOCX, Markdown, TXT, and HTML. Text is extracted, normalized, split into overlapping chunks, embedded, and idempotently replaced when the same logical document is imported again.

The RAG management view lists documents, chunk and embedding counts, indexing timestamp, and status. Operators can delete a document, reindex it, or refresh embeddings without editing files or environment variables.

## Where to import and index

1. Open the Admin at `http://localhost:3002` and sign in.
2. Check the active company in the selector. That tenant will receive the document.
3. In the side menu, click **Knowledge / RAG** (the current interface is displayed in Portuguese as **Conhecimento / RAG**).
4. Under **Import document**, select a supported XLSX, PDF, DOCX, Markdown, TXT, or HTML file from that company's private folder.
5. Click **Import and index** and wait for confirmation.
6. Under **Indexed sources**, confirm a `ready` status and non-zero chunk and embedding counts.

Importing a file into Company Alpha does not make it visible to Company Beta. Documents, chunks, embeddings, corpus version, and semantic cache include `tenantId`. To use the same file for two companies, import it deliberately into each.

Index data remains in persistent PostgreSQL/pgvector storage across container restarts. Deleting volumes with `docker compose down -v` removes this data.

Within the selected company, RAG is shared by the provider chain: the Gateway retrieves context before it chooses the model. Cloudflare, OpenRouter, Gemini, or another fallback therefore receives the same excerpts for that tenant; there is no separate knowledge-base copy per provider and another tenant's knowledge is never queried.

## Embeddings and retrieval

The default local embedding is a deterministic 384-dimensional lexical representation and requires no model download. A tenant can select the optional Ollama embedding adapter, URL, model, and timeout in the Admin.

Retrieval uses pgvector cosine similarity, a bounded result count, tenant filtering, and a configurable score threshold. SQL is parameterized and retrieved content is normalized and screened for basic prompt-injection patterns before entering the model context.
