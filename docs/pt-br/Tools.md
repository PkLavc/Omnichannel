# Tools

A plataforma define contratos para estoque, produtos, garantia, ordem de serviço, clientes e agendamento. Cada tenant pode habilitar uma Tool, configurar endpoint HTTP, autenticação e timeout e testar a conexão pelo Admin.

Um adapter habilitado recebe entrada normalizada, contexto do tenant e sinal de cancelamento. O wrapper aplica timeout e valida uma resposta com `found`, `content` não vazio e dados estruturados opcionais.

## Ordem de execução

1. Identificar e executar Tools habilitadas.
2. Adicionar dados confirmados da Tool ao contexto.
3. Consultar RAG quando nenhuma Tool confirmar resultado.
4. Informar indisponibilidade quando nenhuma fonte fornecer evidência.

Nenhum mock roda por padrão. Stubs de desenvolvimento exigem `ENABLE_MOCK_TOOLS=true` e sempre retornam `found=false`.

Sistemas externos reais devem implementar o contrato HTTP documentado e fornecer credenciais autorizadas por tenant. Credenciais não aparecem nas APIs de leitura nem nos logs.
