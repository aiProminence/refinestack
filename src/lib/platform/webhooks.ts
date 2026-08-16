import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSafeExternalUrl, safeExternalFetch } from "@/lib/security/external-url";
import { redactSecrets, signWebhook, verifyWebhookDelivery } from "@/lib/security/secrets";
import { createAdminClient } from "@/lib/supabase/server";
import type { Json, WorkspaceRole } from "@/types/database";
import type { WebhookEnvelope, WebhookEventName } from "@/types/contracts";
import { ApiProblem } from "./api";

type Table<Row, Insert = Partial<Row>, Update = Partial<Insert>> = {
  Row: Row; Insert: Insert; Update: Update; Relationships: [];
};

type EndpointRow = {
  id: string; workspace_id: string; name: string; endpoint_url: string; secret_ciphertext: string;
  event_names: string[]; enabled: boolean; created_by: string | null; created_at: string; updated_at: string;
};
type DeliveryStatus = "pending" | "delivered" | "failed" | "abandoned";
type DeliveryRow = {
  id: string; workspace_id: string; webhook_endpoint_id: string; event_id: string; event_name: string;
  payload: Json; status: DeliveryStatus; attempt_count: number; next_attempt_at: string | null;
  response_status: number | null; response_excerpt: string | null; delivered_at: string | null; created_at: string;
};
type PlatformDatabase = {
  public: {
    Tables: {
      webhook_endpoints: Table<EndpointRow>;
      webhook_deliveries: Table<DeliveryRow>;
      workspace_members: Table<{ workspace_id: string; user_id: string; role: WorkspaceRole; created_at: string }>;
      audit_events: Table<{
        id: string; workspace_id: string; actor_user_id: string | null; actor_token_id: string | null;
        request_id: string | null; event_type: string; entity_type: string; entity_id: string | null;
        metadata: Json; occurred_at: string;
      }>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: { webhook_delivery_status: DeliveryStatus };
    CompositeTypes: Record<string, never>;
  };
};

type PlatformAdmin = SupabaseClient<PlatformDatabase>;
export const WEBHOOK_MAX_ATTEMPTS = 8;
export const webhookEventNames: WebhookEventName[] = [
  "run.started", "run.completed", "run.partial", "run.failed", "review.required", "action.created", "action.completed",
];

export type WebhookReplayStore = {
  /** Atomically writes a key with expiry and returns false if it already exists. */
  consume(key: string, expiresAt: number): Promise<boolean>;
};

export function webhookRetryDelayMs(attempt: number, random: () => number = Math.random) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Webhook attempt must be a positive integer.");
  const base = Math.min(6 * 60 * 60 * 1000, 30_000 * 4 ** Math.min(attempt - 1, 6));
  const jitter = Math.min(1, Math.max(0, random()));
  return Math.round(base * (0.8 + jitter * 0.4));
}

export function parseWebhookSignature(value: string | null) {
  const match = value?.match(/^sha256=([a-f0-9]{64})$/iu);
  return match?.[1] ?? null;
}

export async function verifyIncomingWebhook(input: {
  timestamp: string;
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
  deliveryId: string;
  replayStore: WebhookReplayStore;
  now?: number;
}) {
  const signature = parseWebhookSignature(input.signatureHeader);
  if (!signature) return false;
  return verifyWebhookDelivery({
    timestamp: input.timestamp, rawBody: input.rawBody, signature, secret: input.secret,
    deliveryId: input.deliveryId, now: input.now, toleranceSeconds: 300,
    consumeReplayKey: (key, expiresAt) => input.replayStore.consume(key, expiresAt),
  });
}

export function encryptWebhookSecret(secret: string, encryptionKey = configuredEncryptionKey()) {
  if (secret.length < 24 || secret.length > 512) throw new ApiProblem(400, "invalid_secret", "Webhook secrets must be 24 to 512 characters.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const payload = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]);
  return `\\x${payload.toString("hex")}`;
}

export function decryptWebhookSecret(ciphertext: string, encryptionKey = configuredEncryptionKey()) {
  const hex = ciphertext.startsWith("\\x") ? ciphertext.slice(2) : ciphertext;
  if (!/^[a-f0-9]+$/iu.test(hex) || hex.length % 2 !== 0) throw new Error("Webhook secret ciphertext is invalid.");
  const payload = Buffer.from(hex, "hex");
  if (payload.length < 30 || payload[0] !== 1) throw new Error("Webhook secret ciphertext version is unsupported.");
  const nonce = payload.subarray(1, 13);
  const tag = payload.subarray(13, 29);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]).toString("utf8");
}

export async function registerWebhookEndpoint(input: {
  workspaceId: string;
  actorUserId: string;
  name: string;
  endpointUrl: string;
  eventNames: WebhookEventName[];
  secret?: string;
  admin?: PlatformAdmin;
}) {
  const admin = input.admin ?? platformAdmin();
  await assertWebhookAdmin(admin, input.workspaceId, input.actorUserId);
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new ApiProblem(400, "invalid_name", "Webhook names must be 2 to 80 characters.");
  const eventNames = [...new Set(input.eventNames)];
  if (eventNames.length === 0 || eventNames.some((event) => !webhookEventNames.includes(event))) {
    throw new ApiProblem(400, "invalid_events", "Choose at least one supported webhook event.");
  }
  await resolveSafeExternalUrl(input.endpointUrl);
  const secret = input.secret ?? randomBytes(32).toString("base64url");
  const { data, error } = await admin.from("webhook_endpoints").insert({
    workspace_id: input.workspaceId, name, endpoint_url: input.endpointUrl,
    secret_ciphertext: encryptWebhookSecret(secret), event_names: eventNames,
    enabled: true, created_by: input.actorUserId,
  }).select("id,name,endpoint_url,event_names,enabled,created_at").single();
  if (error || !data) throw new ApiProblem(409, "webhook_not_created", "The webhook endpoint could not be created.");
  await admin.from("audit_events").insert({
    workspace_id: input.workspaceId, actor_user_id: input.actorUserId, actor_token_id: null, request_id: null,
    event_type: "webhook.created", entity_type: "webhook_endpoint", entity_id: data.id,
    metadata: { name, eventNames },
  });
  return { secret, endpoint: data };
}

export async function disableWebhookEndpoint(input: {
  workspaceId: string;
  actorUserId: string;
  endpointId: string;
  admin?: PlatformAdmin;
}) {
  const admin = input.admin ?? platformAdmin();
  await assertWebhookAdmin(admin, input.workspaceId, input.actorUserId);
  const { data, error } = await admin.from("webhook_endpoints").update({ enabled: false })
    .eq("workspace_id", input.workspaceId).eq("id", input.endpointId).select("id").maybeSingle();
  if (error) throw new ApiProblem(503, "webhook_not_disabled", "The webhook endpoint could not be disabled.");
  if (!data) throw new ApiProblem(404, "not_found", "The requested resource was not found.");
  await admin.from("webhook_deliveries").update({ status: "abandoned", next_attempt_at: null, response_excerpt: "Endpoint disabled." })
    .eq("workspace_id", input.workspaceId).eq("webhook_endpoint_id", input.endpointId).in("status", ["pending", "failed"]);
  await admin.from("audit_events").insert({
    workspace_id: input.workspaceId, actor_user_id: input.actorUserId, actor_token_id: null, request_id: null,
    event_type: "webhook.disabled", entity_type: "webhook_endpoint", entity_id: input.endpointId, metadata: {},
  });
}

export async function enqueueWebhookEvent<T extends Json>(input: {
  workspaceId: string;
  event: WebhookEventName;
  data: T;
  eventId?: string;
  createdAt?: string;
  admin?: PlatformAdmin;
}) {
  const admin = input.admin ?? platformAdmin();
  const eventId = input.eventId ?? randomUUID();
  const envelope: WebhookEnvelope<T> = {
    id: eventId, event: input.event, createdAt: input.createdAt ?? new Date().toISOString(),
    workspaceId: input.workspaceId, data: input.data,
  };
  const { data: endpoints, error } = await admin.from("webhook_endpoints").select("id")
    .eq("workspace_id", input.workspaceId).eq("enabled", true).contains("event_names", [input.event]);
  if (error) throw new Error("Webhook endpoints could not be loaded.");
  if (!endpoints || endpoints.length === 0) return { eventId, deliveryCount: 0 };
  const { error: insertError } = await admin.from("webhook_deliveries").insert(endpoints.map((endpoint) => {
    const deliveryId = randomUUID();
    return {
      id: deliveryId, workspace_id: input.workspaceId, webhook_endpoint_id: endpoint.id, event_id: eventId,
      event_name: input.event, payload: { ...envelope, deliveryId } as unknown as Json, status: "pending" as const,
      attempt_count: 0, next_attempt_at: new Date().toISOString(),
    };
  }));
  if (insertError) throw new Error("Webhook deliveries could not be enqueued.");
  return { eventId, deliveryCount: endpoints.length };
}

export async function dispatchPendingWebhooks(input: {
  limit?: number;
  now?: Date;
  admin?: PlatformAdmin;
} = {}) {
  const admin = input.admin ?? platformAdmin();
  const now = input.now ?? new Date();
  const limit = Math.min(50, Math.max(1, input.limit ?? 10));
  const { data, error } = await admin.from("webhook_deliveries").select("*")
    .in("status", ["pending", "failed"]).or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
    .order("created_at", { ascending: true }).limit(limit);
  if (error) throw new Error("Pending webhook deliveries could not be loaded.");
  const results = [];
  for (const delivery of data ?? []) results.push(await dispatchWebhookDelivery(admin, delivery, now));
  return results;
}

async function dispatchWebhookDelivery(admin: PlatformAdmin, delivery: DeliveryRow, now: Date) {
  if (delivery.attempt_count >= WEBHOOK_MAX_ATTEMPTS) {
    await admin.from("webhook_deliveries").update({ status: "abandoned", next_attempt_at: null })
      .eq("id", delivery.id).eq("workspace_id", delivery.workspace_id);
    return { id: delivery.id, status: "abandoned" as const };
  }
  const attempt = delivery.attempt_count + 1;
  // next_attempt_at doubles as a short claim lease because the schema deliberately has no unbounded "delivering" state.
  const claimExpiresAt = new Date(now.getTime() + 2 * 60_000).toISOString();
  const { data: claimed } = await admin.from("webhook_deliveries").update({ attempt_count: attempt, next_attempt_at: claimExpiresAt })
    .eq("id", delivery.id).eq("workspace_id", delivery.workspace_id).eq("attempt_count", delivery.attempt_count)
    .in("status", ["pending", "failed"]).select("id").maybeSingle();
  if (!claimed) return { id: delivery.id, status: "skipped" as const };

  const { data: endpoint } = await admin.from("webhook_endpoints").select("*")
    .eq("id", delivery.webhook_endpoint_id).eq("workspace_id", delivery.workspace_id).eq("enabled", true).maybeSingle();
  if (!endpoint) {
    await admin.from("webhook_deliveries").update({ status: "abandoned", next_attempt_at: null, response_excerpt: "Endpoint disabled or removed." })
      .eq("id", delivery.id).eq("workspace_id", delivery.workspace_id);
    return { id: delivery.id, status: "abandoned" as const };
  }

  const rawBody = JSON.stringify(delivery.payload);
  const timestamp = String(now.getTime());
  try {
    const secret = decryptWebhookSecret(endpoint.secret_ciphertext);
    const signature = signWebhook(timestamp, rawBody, secret);
    const response = await safeExternalFetch(endpoint.endpoint_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "RefineStack-Webhooks/1.0",
        "X-RefineStack-Delivery": delivery.id,
        "X-RefineStack-Event": delivery.event_name,
        "X-RefineStack-Timestamp": timestamp,
        "X-RefineStack-Signature": `sha256=${signature}`,
      },
      body: rawBody,
    }, { timeoutMs: 8_000, maxBytes: 64_000, maxRedirects: 0 });
    const excerpt = safeExcerpt(await response.text());
    if (response.status >= 200 && response.status < 300) {
      await admin.from("webhook_deliveries").update({
        status: "delivered", response_status: response.status, response_excerpt: excerpt,
        delivered_at: now.toISOString(), next_attempt_at: null,
      }).eq("id", delivery.id).eq("workspace_id", delivery.workspace_id).in("status", ["pending", "failed"]);
      return { id: delivery.id, status: "delivered" as const, responseStatus: response.status };
    }
    return await markRetry(admin, delivery, attempt, now, response.status, excerpt || "Endpoint returned a non-success status.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook request failed.";
    return markRetry(admin, delivery, attempt, now, null, safeExcerpt(message));
  }
}

async function markRetry(
  admin: PlatformAdmin, delivery: DeliveryRow, attempt: number, now: Date,
  responseStatus: number | null, excerpt: string,
) {
  const abandoned = attempt >= WEBHOOK_MAX_ATTEMPTS;
  const nextAttemptAt = abandoned ? null : new Date(now.getTime() + webhookRetryDelayMs(attempt)).toISOString();
  await admin.from("webhook_deliveries").update({
    status: abandoned ? "abandoned" : "failed", response_status: responseStatus,
    response_excerpt: excerpt, next_attempt_at: nextAttemptAt,
  }).eq("id", delivery.id).eq("workspace_id", delivery.workspace_id).in("status", ["pending", "failed"]);
  return { id: delivery.id, status: abandoned ? "abandoned" as const : "failed" as const, responseStatus, nextAttemptAt };
}

function safeExcerpt(value: string) {
  const redacted = redactSecrets(value);
  return (typeof redacted === "string" ? redacted : "Webhook request failed.").slice(0, 500);
}

function configuredEncryptionKey() {
  const value = process.env.APP_ENCRYPTION_KEY;
  if (!value) throw new Error("APP_ENCRYPTION_KEY is not configured.");
  let key: Buffer;
  if (/^[a-f0-9]{64}$/iu.test(value)) key = Buffer.from(value, "hex");
  else key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY must encode exactly 32 bytes.");
  return key;
}

async function assertWebhookAdmin(admin: PlatformAdmin, workspaceId: string, actorUserId: string) {
  const { data, error } = await admin.from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", actorUserId).maybeSingle();
  if (error) throw new ApiProblem(503, "authorization_unavailable", "Authorization is temporarily unavailable.");
  if (!data || !new Set<WorkspaceRole>(["owner", "admin"]).has(data.role)) {
    throw new ApiProblem(403, "forbidden", "Only workspace administrators can manage webhooks.");
  }
}

function platformAdmin() {
  return createAdminClient() as unknown as PlatformAdmin;
}
