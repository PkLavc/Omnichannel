import { sanitizeUntrustedText, untrustedContentGuardrails, untrustedDataEnvelope } from "./prompt-security.js";

export type SpecializedAgentRole = "intake" | "sales" | "customer_care" | "technical" | "quality";

export type SpecializedAgentProfile = {
  role: SpecializedAgentRole;
  label: string;
  customerFacing: boolean;
  mission: string;
  boundaries: readonly string[];
};

export type TenantAgentContext = {
  tenantId: string;
  companyName: string;
  language?: string;
  conversationSummary?: string;
  verifiedContext?: string;
};

export type AgentRoutingInput = {
  message: string;
  previousRole?: SpecializedAgentRole;
  state?: Readonly<Record<string, unknown>>;
  internalPurpose?: "quality_review";
};

export type AgentRoute = {
  role: SpecializedAgentRole;
  previousRole?: SpecializedAgentRole;
  handoff: boolean;
  reason: "internal_quality_review" | "explicit_intent" | "retained_context" | "initial_triage";
  scores: Readonly<Record<"sales" | "customer_care" | "technical", number>>;
};

const profiles: Record<SpecializedAgentRole, SpecializedAgentProfile> = {
  intake: {
    role: "intake",
    label: "Atendimento inicial",
    customerFacing: true,
    mission: "Entender a intenção, responder o que já estiver confirmado e coletar somente os dados mínimos para encaminhar o assunto à especialidade correta.",
    boundaries: [
      "Não diagnostique, negocie nem prometa resultado.",
      "Faça no máximo uma pergunta objetiva por vez e não repita dados já coletados.",
    ],
  },
  sales: {
    role: "sales",
    label: "Comercial",
    customerFacing: true,
    mission: "Descobrir a necessidade, recomendar opções confirmadas e conduzir o cliente a um próximo passo comercial claro.",
    boundaries: [
      "Use somente catálogo, estoque, preço e condição comercial confirmados por Tool, Base/RAG ou regra deste tenant.",
      "Nunca invente desconto, urgência, escassez, benefício ou promessa para fechar a venda.",
    ],
  },
  customer_care: {
    role: "customer_care",
    label: "SAC",
    customerFacing: true,
    mission: "Resolver pós-venda, pedido, cobrança, troca, devolução, garantia e reclamação com rastreabilidade e empatia.",
    boundaries: [
      "Não prometa reembolso, troca, prazo ou cobertura sem fonte oficial aplicável ao caso.",
      "Escalone risco financeiro, jurídico, reclamação grave ou exceção de política conforme as regras da empresa.",
    ],
  },
  technical: {
    role: "technical",
    label: "Assistência técnica",
    customerFacing: true,
    mission: "Fazer triagem técnica segura, coletar sintomas e orientar apenas procedimentos documentados para o produto confirmado.",
    boundaries: [
      "Relato de sintoma não é diagnóstico; diferencie hipótese, teste e fato confirmado.",
      "Não indique abertura, reparo perigoso, peça, custo ou cobertura sem procedimento e fonte confiáveis.",
    ],
  },
  quality: {
    role: "quality",
    label: "Qualidade",
    customerFacing: false,
    mission: "Avaliar atendimentos concluídos quanto a correção, segurança, aderência às fontes e avanço do objetivo, produzindo achados para revisão.",
    boundaries: [
      "Não responda ao cliente, não execute Tools e não altere conhecimento ou prompt.",
      "Separe evidência observável de inferência e encaminhe propostas de mudança ao fluxo de aprovação.",
    ],
  },
};

const routingPatterns: Record<"sales" | "customer_care" | "technical", readonly RegExp[]> = {
  sales: [
    /\b(?:comprar|compra|or[cç]amento|pre[cç]o|valor|produto|modelo|estoque|disponibilidade|desconto|promo[cç][aã]o|parcelamento)\b/iu,
    /\b(?:qual|quais)\b.{0,35}\b(?:op[cç][aã]o|produto|modelo|recomenda)\b/iu,
  ],
  customer_care: [
    /\b(?:sac|reclama[cç][aã]o|procon|ouvidoria|troca|devolu[cç][aã]o|reembolso|garantia|cobertura)\b/iu,
    /\b(?:pedido|entrega|pagamento|cobran[cç]a|estorno|nota fiscal|p[oó]s[- ]?venda)\b/iu,
  ],
  technical: [
    /\b(?:defeito|erro|falha|quebrad[oa]|n[aã]o liga|travando|superaquece|bateria|tela|reparo|assist[eê]ncia t[eé]cnica|diagn[oó]stico)\b/iu,
    /\b(?:como|pode)\b.{0,30}\b(?:consertar|resolver|testar|reiniciar|configurar)\b/iu,
  ],
};

function cleanTenantId(value: string) {
  const tenantId = value.normalize("NFKC").trim();
  if (!tenantId || tenantId.length > 200 || /[\r\n\u0000]/u.test(tenantId)) {
    throw new Error("Contexto de agente exige tenantId válido");
  }
  return tenantId;
}

function validRole(value: unknown): value is SpecializedAgentRole {
  return value === "intake" || value === "sales" || value === "customer_care" || value === "technical" || value === "quality";
}

function customerRole(value: unknown): value is Exclude<SpecializedAgentRole, "quality"> {
  return validRole(value) && value !== "quality";
}

function normalizedIntent(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
}

function roleFromLegacySector(value: unknown): SpecializedAgentRole | undefined {
  if (value === "commercial") return "sales";
  if (value === "postSale") return "customer_care";
  if (value === "support") return "technical";
  return undefined;
}

function scoreIntent(message: string) {
  const normalized = normalizedIntent(message);
  const scores = { sales: 0, customer_care: 0, technical: 0 };
  for (const [role, patterns] of Object.entries(routingPatterns) as Array<[keyof typeof scores, readonly RegExp[]]>) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(normalized)) scores[role] += 1;
    }
  }
  return scores;
}

/**
 * Stateless and deterministic routing. Neutral turns retain the established
 * specialty; quality is reachable only through an explicit internal purpose.
 */
export function routeSpecializedAgent(input: AgentRoutingInput): AgentRoute {
  const scores = scoreIntent(input.message);
  const stateRole = customerRole(input.state?.activeAgent)
    ? input.state.activeAgent
    : roleFromLegacySector(input.state?.sector);
  const previousRole = customerRole(input.previousRole) ? input.previousRole : stateRole;

  if (input.internalPurpose === "quality_review") {
    return { role: "quality", previousRole, handoff: previousRole !== "quality", reason: "internal_quality_review", scores };
  }

  const priority: Array<keyof typeof scores> = ["customer_care", "technical", "sales"];
  const highest = Math.max(...Object.values(scores));
  const candidates = priority.filter((role) => scores[role] === highest && highest > 0);
  let selected = candidates[0];
  if (previousRole && candidates.includes(previousRole as keyof typeof scores)) selected = previousRole as keyof typeof scores;

  if (!selected) {
    const role = previousRole ?? "intake";
    return {
      role,
      previousRole,
      handoff: false,
      reason: previousRole ? "retained_context" : "initial_triage",
      scores,
    };
  }

  return {
    role: selected,
    previousRole,
    handoff: Boolean(previousRole && previousRole !== selected),
    reason: "explicit_intent",
    scores,
  };
}

export function specializedAgentProfile(role: SpecializedAgentRole) {
  return profiles[role];
}

export function listSpecializedAgentProfiles() {
  return Object.values(profiles);
}

/**
 * Refuses to combine shared context from different tenants. This helper has no
 * process-wide cache, so one company's summary cannot bleed into another bot.
 */
export function mergeTenantAgentContext(base: TenantAgentContext, update: Partial<TenantAgentContext>) {
  const tenantId = cleanTenantId(base.tenantId);
  if (update.tenantId !== undefined && cleanTenantId(update.tenantId) !== tenantId) {
    throw new Error("Não é permitido combinar contexto de tenants diferentes");
  }
  return { ...base, ...update, tenantId } satisfies TenantAgentContext;
}

/** Produces a compact role prompt; shared customer text remains untrusted data. */
export function buildSpecializedAgentPrompt(role: SpecializedAgentRole, context: TenantAgentContext) {
  const profile = specializedAgentProfile(role);
  const tenantId = cleanTenantId(context.tenantId);
  const companyName = sanitizeUntrustedText(context.companyName, 160) || "a empresa configurada";
  const language = sanitizeUntrustedText(context.language ?? "pt-BR", 35) || "pt-BR";
  const lines = [
    `PAPEL ATIVO: ${profile.label}. Empresa: ${companyName}. Idioma: ${language}.`,
    profile.mission,
    ...profile.boundaries,
    ...untrustedContentGuardrails(),
  ];
  if (context.conversationSummary) {
    lines.push(untrustedDataEnvelope("history", context.conversationSummary, 4_000));
  }
  if (context.verifiedContext) {
    lines.push(untrustedDataEnvelope("rag", context.verifiedContext, 8_000));
  }
  // Validate and bind the context without exposing an internal tenant identifier
  // to the model or customer.
  void tenantId;
  return lines.join("\n");
}
