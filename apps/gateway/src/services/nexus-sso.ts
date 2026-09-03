import { AdminRole } from "@prisma/client";
import { z } from "zod";

export const NEXUS_SSO_DEFAULT_REDEEM_URL = "https://sso.example.com/api/omnichannel/redeem";
export const NEXUS_SSO_ISSUER = process.env.NEXUS_SSO_ISSUER ?? "https://sso.example.com";
export const NEXUS_SSO_AUDIENCE = process.env.NEXUS_SSO_AUDIENCE ?? "omnichannel-admin";
export const NEXUS_SSO_MAX_TICKET_SECONDS = 60;
export const NEXUS_SSO_ISSUED_AT_SKEW_SECONDS = 10 * 60;

const nexusClaimsSchema = z.object({
  version: z.literal(1),
  issuer: z.literal(NEXUS_SSO_ISSUER),
  audience: z.literal(NEXUS_SSO_AUDIENCE),
  subject: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(1).max(160),
  role: z.nativeEnum(AdminRole),
  tenantSlugs: z.array(
    z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  ).max(500),
  jti: z.string().uuid(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict();

const nexusRedeemEnvelopeSchema = z.object({
  success: z.literal(true),
  claims: z.unknown(),
}).strict();

export type NexusSsoClaims = z.infer<typeof nexusClaimsSchema>;

export class NexusSsoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "NexusSsoError";
  }
}

export function validateNexusSsoClaims(value: unknown, now = new Date()): NexusSsoClaims {
  const parsed = nexusClaimsSchema.safeParse(value);
  if (!parsed.success) {
    throw new NexusSsoError("invalid_sso_claims", "As credenciais emitidas pelo Nexus são inválidas.", 401);
  }
  const claims = parsed.data;
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const lifetime = claims.expiresAt - claims.issuedAt;
  if (
    claims.issuedAt > nowSeconds + NEXUS_SSO_ISSUED_AT_SKEW_SECONDS
    || claims.expiresAt <= nowSeconds
    || lifetime <= 0
    || lifetime > NEXUS_SSO_MAX_TICKET_SECONDS
    || new Set(claims.tenantSlugs).size !== claims.tenantSlugs.length
  ) {
    throw new NexusSsoError("invalid_sso_claims", "As credenciais emitidas pelo Nexus são inválidas ou expiraram.", 401);
  }
  return claims;
}

export type NexusSsoRedeemerOptions = {
  redeemUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export class NexusSsoRedeemer {
  private readonly redeemUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: NexusSsoRedeemerOptions = {}) {
    this.redeemUrl = options.redeemUrl ?? NEXUS_SSO_DEFAULT_REDEEM_URL;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    let url: URL;
    try {
      url = new URL(this.redeemUrl);
    } catch {
      throw new NexusSsoError("invalid_sso_configuration", "NEXUS_SSO_REDEEM_URL é inválida.", 500);
    }
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new NexusSsoError("invalid_sso_configuration", "O endpoint SSO precisa utilizar HTTPS.", 500);
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 250 || this.timeoutMs > 30_000) {
      throw new NexusSsoError("invalid_sso_configuration", "NEXUS_SSO_REDEEM_TIMEOUT_MS é inválido.", 500);
    }
  }

  async redeem(code: string): Promise<NexusSsoClaims> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.redeemUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ code }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new NexusSsoError("sso_upstream_timeout", "O Nexus não respondeu dentro do prazo.", 504);
      }
      throw new NexusSsoError("sso_upstream_failed", "Não foi possível validar o acesso no Nexus.", 502);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        throw new NexusSsoError("sso_ticket_invalid", "O acesso do Nexus é inválido ou já expirou.", 401);
      }
      throw new NexusSsoError("sso_upstream_failed", "O Nexus não conseguiu validar o acesso.", 502);
    }

    let body: unknown;
    try {
      const raw = await response.text();
      if (raw.length > 64 * 1_024) throw new Error("response_too_large");
      body = JSON.parse(raw);
    } catch {
      throw new NexusSsoError("invalid_sso_response", "O Nexus retornou uma resposta inválida.", 502);
    }
    const envelope = nexusRedeemEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      throw new NexusSsoError("invalid_sso_response", "O Nexus retornou uma resposta inválida.", 502);
    }
    return validateNexusSsoClaims(envelope.data.claims, this.now());
  }
}
