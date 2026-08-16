import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, ProviderKey } from "@/types/database";
import { ApiProblem } from "./api";

export const MAX_JSON_BODY_BYTES = 64_000;

export const UUID = z.string().uuid();
export const runRequestSchema = z.object({
  questionVersionIds: z.array(UUID).min(1).max(200).transform((values) => [...new Set(values)]),
  providers: z.array(z.enum(["openai", "claude", "google_ai_overview"])).min(1).max(3)
    .transform((values) => [...new Set(values)]),
}).strict();

export function requireUuid(value: string) {
  if (!UUID.safeParse(value).success) throw new ApiProblem(404, "not_found", "The requested resource was not found.");
  return value;
}

export function requireIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key");
  if (!value || value.length < 8 || value.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new ApiProblem(400, "invalid_idempotency_key", "Idempotency-Key must be 8 to 200 letters, numbers, dots, colons, underscores, or hyphens.");
  }
  return value;
}

export async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ApiProblem(415, "unsupported_media_type", "Send an application/json request body.");
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new ApiProblem(413, "request_too_large", "The request body is too large.");
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  let raw: unknown;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_JSON_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new ApiProblem(413, "request_too_large", "The request body is too large.");
        }
        chunks.push(value);
      }
    }

    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    throw new ApiProblem(400, "invalid_json", "The request body is not valid JSON.");
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new ApiProblem(422, "validation_failed", "The request body is invalid.", result.error.flatten());
  return result.data;
}

export async function ensureProject(admin: SupabaseClient<Database>, workspaceId: string, projectId: string) {
  requireUuid(projectId);
  const { data, error } = await admin.from("projects")
    .select("id,name,domain,category,default_market,default_locale,languages,status,created_at,updated_at")
    .eq("workspace_id", workspaceId).eq("id", projectId).maybeSingle();
  if (error) throw new ApiProblem(503, "data_unavailable", "Project data is temporarily unavailable.");
  if (!data) throw new ApiProblem(404, "not_found", "The requested resource was not found.");
  return data;
}

export async function ensureRun(admin: SupabaseClient<Database>, workspaceId: string, runId: string, projectId?: string) {
  requireUuid(runId);
  let query = admin.from("runs").select("id,project_id,status,requested_capture_count,estimated_max_cost_usd,started_at,completed_at,cancelled_at,cancellation_reason,created_at")
    .eq("workspace_id", workspaceId).eq("id", runId);
  if (projectId) query = query.eq("project_id", projectId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new ApiProblem(503, "data_unavailable", "Run data is temporarily unavailable.");
  if (!data) throw new ApiProblem(404, "not_found", "The requested resource was not found.");
  return data;
}

export async function existingRunMatches(
  admin: SupabaseClient<Database>, workspaceId: string, projectId: string, idempotencyKey: string,
  questionVersionIds: string[], providers: ProviderKey[],
) {
  const { data: run, error } = await admin.from("runs").select("id").eq("workspace_id", workspaceId)
    .eq("project_id", projectId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (error) throw new ApiProblem(503, "data_unavailable", "Run data is temporarily unavailable.");
  if (!run) return null;
  const { data: items, error: itemsError } = await admin.from("run_items").select("question_version_id,provider")
    .eq("workspace_id", workspaceId).eq("project_id", projectId).eq("run_id", run.id);
  if (itemsError) throw new ApiProblem(503, "data_unavailable", "Run data is temporarily unavailable.");
  const expected = new Set(questionVersionIds.flatMap((questionId) => providers.map((provider) => `${questionId}:${provider}`)));
  const actual = new Set((items ?? []).map((item) => `${item.question_version_id}:${item.provider}`));
  if (expected.size !== actual.size || [...expected].some((item) => !actual.has(item))) {
    throw new ApiProblem(409, "idempotency_conflict", "This Idempotency-Key was already used with a different request.");
  }
  return run.id;
}

const runLocks = new Map<string, Promise<void>>();

/** Serializes matching keys within a server instance; the database unique key remains authoritative across instances. */
export async function withIdempotencyLock<T>(key: string, operation: () => Promise<T>) {
  const previous = runLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  runLocks.set(key, queued);
  await previous;
  try { return await operation(); } finally {
    release();
    if (runLocks.get(key) === queued) runLocks.delete(key);
  }
}
