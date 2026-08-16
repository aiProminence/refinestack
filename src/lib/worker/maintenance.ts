import "server-only";
import type { ProviderFailureCode, ProviderKey } from "@/types/contracts";
import type { ProductDbClient } from "@/lib/db";
import { processWorkspaceStorageCleanup } from "@/lib/db/workspace-lifecycle";
import { configuredProviderKeys } from "./adapters";

const DISPLAY_NAMES: Record<ProviderKey, string> = { openai: "OpenAI", claude: "Anthropic Claude", google_ai_overview: "Google AI Overview via SerpAPI" };
const PAGE_SIZE = 1_000;
const WRITE_BATCH_SIZE = 500;

async function loadWorkspaces(client: ProductDbClient) {
  const rows: Array<{ id: string }> = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client.from("workspaces").select("id").range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error("Unable to synchronize provider availability.");
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_SIZE) return rows;
  }
}

async function loadConnections(client: ProductDbClient) {
  const rows: Array<{ workspace_id: string; provider: ProviderKey; enabled: boolean }> = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client.from("provider_connections").select("workspace_id,provider,enabled").range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error("Unable to synchronize provider availability.");
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_SIZE) return rows;
  }
}

function batches<T>(rows: T[]) {
  return Array.from({ length: Math.ceil(rows.length / WRITE_BATCH_SIZE) }, (_, index) => rows.slice(index * WRITE_BATCH_SIZE, (index + 1) * WRITE_BATCH_SIZE));
}

export async function syncProviderHealth(client: ProductDbClient, env: NodeJS.ProcessEnv = process.env) {
  const providers = configuredProviderKeys(env);
  const [workspaces, connections] = await Promise.all([loadWorkspaces(client), loadConnections(client)]);
  const existing = new Set(connections.map((row) => `${row.workspace_id}:${row.provider}`));
  const missing = workspaces.flatMap(({ id }) => providers.filter((provider) => !existing.has(`${id}:${provider}`)).map((provider) => ({ workspace_id: id, provider, display_name: DISPLAY_NAMES[provider], enabled: true, health_state: "unchecked", remediation: "Awaiting the first successful capture to verify this provider." })));
  for (const batch of batches(missing)) {
    const { error } = await client.from("provider_connections").upsert(batch, { onConflict: "workspace_id,provider", ignoreDuplicates: true });
    if (error) throw new Error("Unable to register configured providers.");
  }
  const quotaRows = workspaces.map(({ id }) => ({ workspace_id: id }));
  for (const batch of batches(quotaRows)) {
    const { error } = await client.from("workspace_quotas").upsert(batch, { onConflict: "workspace_id", ignoreDuplicates: true });
    if (error) throw new Error("Unable to ensure workspace quotas.");
  }
  return { workspaces: workspaces.length, providers: providers.length, inserted: missing.length };
}

export async function markProviderHealthy(client: ProductDbClient, workspaceId: string, provider: ProviderKey, now = new Date().toISOString()) {
  const { error } = await client.from("provider_connections").update({ health_state: "healthy", remediation: null, last_checked_at: now }).eq("workspace_id", workspaceId).eq("provider", provider);
  if (error) throw new Error("Unable to update provider health.");
}

export async function markProviderFailure(client: ProductDbClient, workspaceId: string, provider: ProviderKey, code: ProviderFailureCode, now = new Date().toISOString()) {
  const unavailable = code === "authentication" || code === "unavailable";
  const remediation = code === "authentication" ? "Provider authentication failed. Rotate or replace the server credential." : code === "unavailable" ? "Provider is unavailable or not configured. Check the server credential and provider status." : "Recent provider requests failed. Review the typed attempt errors before retrying.";
  const { error } = await client.from("provider_connections").update({ health_state: unavailable ? "unavailable" : "degraded", remediation, last_checked_at: now }).eq("workspace_id", workspaceId).eq("provider", provider);
  if (error) throw new Error("Unable to update provider health.");
}

export async function drainWorkspaceStorageCleanupQueue(
  client: ProductDbClient,
  workerId: string,
  limit = 10,
) {
  return processWorkspaceStorageCleanup(client, { workerId, limit, leaseSeconds: 300 });
}
