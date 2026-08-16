import { describe, expect, it, vi } from "vitest";
import type { ProductDbClient } from "@/lib/db";
import { drainWorkspaceStorageCleanupQueue, syncProviderHealth } from "@/lib/worker/maintenance";

describe("provider and quota maintenance", () => {
  it("registers configured providers as unchecked without re-enabling an explicit revocation", async () => {
    const providerUpsert = vi.fn().mockResolvedValue({ error: null });
    const quotaUpsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table: string) => {
      if (table === "workspaces") return { select: vi.fn(() => ({ range: vi.fn().mockResolvedValue({ data: [{ id: "workspace-1" }], error: null }) })) };
      if (table === "provider_connections") return {
        select: vi.fn(() => ({ range: vi.fn().mockResolvedValue({ data: [{ workspace_id: "workspace-1", provider: "openai", enabled: false }], error: null }) })),
        upsert: providerUpsert,
      };
      if (table === "workspace_quotas") return { upsert: quotaUpsert };
      throw new Error(`Unexpected table ${table}`);
    });
    const result = await syncProviderHealth({ from } as unknown as ProductDbClient, {
      NODE_ENV: "test", OPENAI_API_KEY: "openai-key", ANTHROPIC_API_KEY: "anthropic-key",
    } as NodeJS.ProcessEnv);
    expect(result).toEqual({ workspaces: 1, providers: 2, inserted: 1 });
    expect(providerUpsert).toHaveBeenCalledWith([
      expect.objectContaining({ workspace_id: "workspace-1", provider: "claude", enabled: true, health_state: "unchecked", remediation: expect.stringContaining("first successful capture") }),
    ], { onConflict: "workspace_id,provider", ignoreDuplicates: true });
    expect(quotaUpsert).toHaveBeenCalledWith([{ workspace_id: "workspace-1" }], { onConflict: "workspace_id", ignoreDuplicates: true });
  });

  it("leases exact storage cleanup jobs through the service-only database boundary", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const result = await drainWorkspaceStorageCleanupQueue({ rpc } as unknown as ProductDbClient, "worker:test", 7);
    expect(result).toEqual({ claimed: 0, succeeded: 0, deferred: 0, abandoned: 0 });
    expect(rpc).toHaveBeenCalledWith("claim_workspace_storage_cleanup_jobs", {
      p_worker_id: "worker:test",
      p_limit: 7,
      p_lease_seconds: 300,
      p_cleanup_id: null,
    });
  });
});
