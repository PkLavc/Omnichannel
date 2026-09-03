export const ASSISTANT_PROMPT_DEFINITION = "assistant-bundle";

export type PromptBundle = {
  system: string;
  commercial: string;
  support: string;
  postSale: string;
};

const LIMITS: Record<keyof PromptBundle, number> = {
  system: 30_000,
  commercial: 20_000,
  support: 20_000,
  postSale: 20_000,
};

function cleanField(value: unknown, maximum: number) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim().slice(0, maximum);
}

/**
 * Prompt versions use a single JSON bundle so a canary never mixes commercial,
 * support and post-sale instructions from different releases. Plain text is
 * accepted as a backwards-compatible system-only prompt.
 */
export function parsePromptBundle(content: string): PromptBundle {
  const normalized = content.normalize("NFKC").trim();
  if (!normalized) return { system: "", commercial: "", support: "", postSale: "" };
  let value: unknown;
  try {
    value = JSON.parse(normalized);
  } catch {
    return { system: normalized.slice(0, LIMITS.system), commercial: "", support: "", postSale: "" };
  }
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    system: cleanField(record.system, LIMITS.system),
    commercial: cleanField(record.commercial, LIMITS.commercial),
    support: cleanField(record.support, LIMITS.support),
    postSale: cleanField(record.postSale, LIMITS.postSale),
  };
}

export function serializePromptBundle(value: Partial<PromptBundle>) {
  return JSON.stringify({
    system: cleanField(value.system, LIMITS.system),
    commercial: cleanField(value.commercial, LIMITS.commercial),
    support: cleanField(value.support, LIMITS.support),
    postSale: cleanField(value.postSale, LIMITS.postSale),
  }, null, 2);
}

export function applyPromptBundle<T extends PromptBundle>(base: T, content?: string | null): T {
  if (!content) return base;
  return { ...base, ...parsePromptBundle(content) };
}
