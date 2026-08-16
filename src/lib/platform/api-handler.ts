import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/types/database";
import { apiError, ApiProblem, apiResponse, apiSuccess, requestId } from "./api";
import { authenticateApiRequest, parseBearerToken, type ApiScope, type ApiTokenPrincipal } from "./tokens";

export type ApiContext = {
  admin: SupabaseClient<Database>;
  principal: ApiTokenPrincipal;
  requestId: string;
  url: URL;
};

type ApiOperationResult = { data: unknown; status?: number; headers?: HeadersInit } | Response;

const DEFAULT_LIMITS: Record<ApiScope, number> = { read: 60, run: 10, export: 10 };
const rateLimitResult = z.object({
  allowed: z.boolean(), used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(), resetAt: z.string().datetime({ offset: true }),
});

type RateLimitRpc = (
  name: "consume_api_rate_limit",
  args: { p_token_id: string; p_scope: ApiScope; p_limit: number; p_window_seconds: number },
) => Promise<{ data: unknown; error: { code?: string } | null }>;

export async function withApiRequest(
  request: Request,
  scope: ApiScope,
  operation: (context: ApiContext) => Promise<ApiOperationResult>,
) {
  const id = requestId(request);
  let admin: SupabaseClient<Database> | null = null;
  let principal: ApiTokenPrincipal | null = null;
  const audited = async (response: Response) => {
    if (!admin || !principal) return response;
    try {
      await writeRequestAudit(admin, principal, request, scope, id, response.status);
      return response;
    } catch {
      return apiError(500, "audit_unavailable", "The request audit could not be recorded.", id);
    }
  };
  try {
    if (!parseBearerToken(request.headers.get("authorization"))) {
      throw new ApiProblem(401, "invalid_access_token", "A valid bearer token is required.");
    }
    admin = createAdminClient();
    principal = await authenticateApiRequest(request, scope, admin);
    const limit = rateLimitFor(scope);
    const rate = await reserveGlobalRateSlot(admin, principal, scope, limit);
    if (!rate.allowed) {
      throw new ApiProblem(429, "rate_limit_exceeded", "The token rate limit has been reached. Try again after the current minute.", { limit, windowSeconds: 60, resetAt: rate.resetAt });
    }
    const result = await operation({ admin, principal, requestId: id, url: new URL(request.url) });
    if (result instanceof Response) {
      const response = apiResponse(result, id);
      response.headers.set("X-RateLimit-Limit", String(limit));
      response.headers.set("X-RateLimit-Remaining", String(rate.remaining));
      response.headers.set("X-RateLimit-Reset", rate.resetAt);
      return await audited(response);
    }
    const status = result.status ?? 200;
    const response = apiSuccess(result.data, id, status);
    if (result.headers) for (const [key, value] of new Headers(result.headers)) response.headers.set(key, value);
    response.headers.set("X-RateLimit-Limit", String(limit));
    response.headers.set("X-RateLimit-Remaining", String(rate.remaining));
    response.headers.set("X-RateLimit-Reset", rate.resetAt);
    return await audited(response);
  } catch (error) {
    if (error instanceof ApiProblem) {
      const response = apiError(error.status, error.code, error.message, id, error.details);
      if (error.status === 401) response.headers.set("WWW-Authenticate", 'Bearer realm="RefineStack API"');
      if (error.status === 429) {
        const resetAt = rateLimitResetAt(error.details);
        response.headers.set("Retry-After", String(resetAt ? Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000)) : 60));
        if (resetAt) response.headers.set("X-RateLimit-Reset", resetAt);
      }
      return await audited(response);
    }
    return await audited(apiError(500, "internal_error", "The request could not be completed.", id));
  }
}

function rateLimitFor(scope: ApiScope) {
  const envName = `API_RATE_LIMIT_${scope.toUpperCase()}_PER_MINUTE`;
  const configured = Number(process.env[envName]);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 10_000 ? configured : DEFAULT_LIMITS[scope];
}

export async function reserveGlobalRateSlot(
  admin: SupabaseClient<Database>, principal: ApiTokenPrincipal, scope: ApiScope, limit: number,
) {
  const rateLimitRpc = admin.rpc as unknown as RateLimitRpc;
  const { data, error } = await rateLimitRpc(
    "consume_api_rate_limit",
    { p_token_id: principal.tokenId, p_scope: scope, p_limit: limit, p_window_seconds: 60 },
  );
  if (error?.code === "42501") throw new ApiProblem(401, "invalid_access_token", "A valid bearer token is required.");
  if (error) throw new ApiProblem(503, "rate_limit_unavailable", "Rate limiting is temporarily unavailable.");
  const parsed = rateLimitResult.safeParse(data);
  if (!parsed.success) throw new ApiProblem(503, "rate_limit_unavailable", "Rate limiting is temporarily unavailable.");
  return parsed.data;
}

function rateLimitResetAt(details: unknown) {
  if (!details || typeof details !== "object" || !("resetAt" in details)) return null;
  const value = (details as { resetAt?: unknown }).resetAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export async function writeRequestAudit(
  admin: SupabaseClient<Database>, principal: ApiTokenPrincipal, request: Request,
  scope: ApiScope, id: string, status: number,
) {
  const url = new URL(request.url);
  const metadata: Json = { method: request.method, path: url.pathname, scope, status };
  const { error } = await admin.from("audit_events").insert({
    workspace_id: principal.workspaceId, actor_user_id: principal.userId, actor_token_id: principal.tokenId,
    request_id: id, event_type: `api.request.${scope}`, entity_type: "api_request", entity_id: null, metadata,
  });
  if (error) throw new Error("API request audit insertion failed.");
}
