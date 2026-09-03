export type ProviderType = "cloudflare" | "openrouter" | "gemini" | "ollama" | "openai-compatible";
export type ToolResult = { name: string; found: boolean; content: string; data?: Record<string, unknown> };
export type TenantSettings = Record<string, unknown>;
