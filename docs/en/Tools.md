# Tools

The platform defines Tool contracts for inventory, products, warranty, service orders, customers, and scheduling. Each tenant can enable a Tool, configure an HTTP endpoint, authentication, and timeout, and test the connection from the Admin.

An enabled Tool adapter receives normalized input, tenant context, and an abort signal. The execution wrapper enforces timeout and validates a response containing `found`, non-empty `content`, and optional structured data.

## Runtime order

1. Match and run enabled Tools.
2. Add confirmed Tool data to the model context.
3. Query RAG when no Tool returns a confirmed result.
4. State that information is unavailable when neither source provides evidence.

No mock Tool runs by default. Development stubs require the explicit `ENABLE_MOCK_TOOLS=true` switch and always return `found=false`.

Real external systems must implement the documented HTTP response contract and provide tenant-authorized credentials. Credentials are not exposed by read APIs or logs.
