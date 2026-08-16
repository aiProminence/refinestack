import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateOpaqueToken } from "@/lib/security/secrets";
import { createAdminClient } from "@/lib/supabase/server";
import type { Database, Json, WorkspaceRole } from "@/types/database";
import { ApiProblem } from "./api";

export const apiScopes = ["read", "run", "export"] as const;
export type ApiScope = (typeof apiScopes)[number];

export type ApiTokenPrincipal = {
  tokenId: string;
  tokenName: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  scopes: ApiScope[];
};

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };
const SCOPE_ROLE: Record<ApiScope, WorkspaceRole> = { read: "viewer", run: "analyst", export: "owner" };

export function hashApiToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function parseBearerToken(value: string | null) {
  if (!value) return null;
  const match = value.match(/^Bearer ([A-Za-z0-9_-]{32,200})$/u);
  return match?.[1] ?? null;
}

export function roleAllowsScope(role: WorkspaceRole, scope: ApiScope) {
  return ROLE_RANK[role] >= ROLE_RANK[SCOPE_ROLE[scope]];
}

function normalizeScopes(scopes: string[]): ApiScope[] {
  return apiScopes.filter((scope) => scopes.includes(scope));
}

export async function authenticateApiRequest(
  request: Request,
  requiredScope: ApiScope,
  admin: SupabaseClient<Database> = createAdminClient(),
): Promise<ApiTokenPrincipal> {
  const bearer = parseBearerToken(request.headers.get("authorization"));
  if (!bearer) throw new ApiProblem(401, "invalid_access_token", "A valid bearer token is required.");

  const tokenHash = hashApiToken(bearer);
  const { data: token, error } = await admin
    .from("api_tokens")
    .select("id,workspace_id,name,scopes,created_by,expires_at,revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) throw new ApiProblem(503, "authorization_unavailable", "Authorization is temporarily unavailable.");

  const expired = token?.expires_at != null && new Date(token.expires_at).getTime() <= Date.now();
  if (!token || token.revoked_at || expired || !token.created_by) {
    throw new ApiProblem(401, "invalid_access_token", "A valid bearer token is required.");
  }

  const { data: member, error: memberError } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", token.workspace_id)
    .eq("user_id", token.created_by)
    .maybeSingle();
  if (memberError) throw new ApiProblem(503, "authorization_unavailable", "Authorization is temporarily unavailable.");
  if (!member) throw new ApiProblem(401, "invalid_access_token", "A valid bearer token is required.");

  const scopes = normalizeScopes(token.scopes);
  if (!scopes.includes(requiredScope) || !roleAllowsScope(member.role, requiredScope)) {
    throw new ApiProblem(403, "insufficient_scope", `This operation requires the ${requiredScope} scope.`);
  }

  await admin.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", token.id);
  return {
    tokenId: token.id,
    tokenName: token.name,
    workspaceId: token.workspace_id,
    userId: token.created_by,
    role: member.role,
    scopes,
  };
}

export async function createApiToken(input: {
  workspaceId: string;
  actorUserId: string;
  name: string;
  scopes: ApiScope[];
  expiresAt?: string | null;
  admin?: SupabaseClient<Database>;
}) {
  const admin = input.admin ?? createAdminClient();
  const name = input.name.trim();
  const scopes = [...new Set(input.scopes)];
  if (name.length < 2 || name.length > 80) throw new ApiProblem(400, "invalid_name", "Token names must be 2 to 80 characters.");
  if (scopes.length === 0 || scopes.some((scope) => !apiScopes.includes(scope))) {
    throw new ApiProblem(400, "invalid_scopes", "Choose at least one supported token scope.");
  }
  if (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())) {
    throw new ApiProblem(400, "invalid_expiry", "Token expiry must be a future date and time.");
  }
  const { data: member } = await admin.from("workspace_members").select("role")
    .eq("workspace_id", input.workspaceId).eq("user_id", input.actorUserId).maybeSingle();
  if (member?.role !== "owner") throw new ApiProblem(403, "forbidden", "Only workspace owners can create API tokens.");

  const plaintext = generateOpaqueToken("rfs");
  const tokenHash = hashApiToken(plaintext);
  const tokenPrefix = plaintext.slice(0, 12);
  const { data, error } = await admin.from("api_tokens").insert({
    workspace_id: input.workspaceId,
    name,
    token_prefix: tokenPrefix,
    token_hash: tokenHash,
    scopes,
    created_by: input.actorUserId,
    expires_at: input.expiresAt ?? null,
  }).select("id,name,token_prefix,scopes,expires_at,created_at").single();
  if (error || !data) throw new ApiProblem(409, "token_not_created", "The API token could not be created.");
  await writeTokenAudit(admin, input.workspaceId, input.actorUserId, "api_token.created", data.id, { name, scopes });
  return { token: plaintext, record: data };
}

export async function revokeApiToken(input: {
  workspaceId: string;
  actorUserId: string;
  tokenId: string;
  admin?: SupabaseClient<Database>;
}) {
  const admin = input.admin ?? createAdminClient();
  const { data: member } = await admin.from("workspace_members").select("role")
    .eq("workspace_id", input.workspaceId).eq("user_id", input.actorUserId).maybeSingle();
  if (member?.role !== "owner") throw new ApiProblem(403, "forbidden", "Only workspace owners can revoke API tokens.");
  const { data, error } = await admin.from("api_tokens").update({ revoked_at: new Date().toISOString() })
    .eq("workspace_id", input.workspaceId).eq("id", input.tokenId).is("revoked_at", null).select("id").maybeSingle();
  if (error) throw new ApiProblem(503, "token_not_revoked", "The API token could not be revoked.");
  if (!data) throw new ApiProblem(404, "not_found", "The requested resource was not found.");
  await writeTokenAudit(admin, input.workspaceId, input.actorUserId, "api_token.revoked", input.tokenId, {});
}

async function writeTokenAudit(
  admin: SupabaseClient<Database>, workspaceId: string, actorUserId: string,
  eventType: string, entityId: string, metadata: Json,
) {
  await admin.from("audit_events").insert({
    workspace_id: workspaceId, actor_user_id: actorUserId, actor_token_id: null,
    request_id: null, event_type: eventType, entity_type: "api_token", entity_id: entityId, metadata,
  });
}
