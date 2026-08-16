import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deleteWorkspace, processWorkspaceStorageCleanup } from "@/lib/db/workspace-lifecycle";
import type { Database } from "@/types/database";

const workspaceId = "018f47d2-83c3-7b80-a855-69b9298ab2a1";
const actorId = "018f47d2-83c3-7b80-a855-69b9298ab2a2";
const eventId = "018f47d2-83c3-7b80-a855-69b9298ab2a3";
const cleanupId = "018f47d2-83c3-7b80-a855-69b9298ab2a4";
const cleanupJobId = "018f47d2-83c3-7b80-a855-69b9298ab2a5";
const reauthenticatedAt = "2026-08-16T12:00:00.000Z";
const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260816154500_secure_workspace_deletion.sql",
), "utf8");
const storageCleanupMigration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260816155800_workspace_storage_cleanup.sql",
), "utf8");
const storageCleanupIndexMigration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260816157500_cover_storage_cleanup_foreign_key.sql",
), "utf8");
const finalIntegrityMigration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260816158500_final_integrity_guards.sql",
), "utf8");

describe("secure workspace deletion", () => {
  it("keeps the destructive database boundary service-only and retains a durable receipt", () => {
    expect(migration).toContain("revoke delete on public.workspaces from public, anon, authenticated");
    expect(migration).toContain("create table private.workspace_deletion_events");
    expect(migration).toContain("for update");
    expect(migration).toContain("actor_role is distinct from 'owner'::public.workspace_role");
    expect(migration).toContain("p_reauthenticated_at < deletion_time - interval '5 minutes'");
    expect(migration).toContain("p_confirmation = workspace_row.slug");
    expect(migration).toContain("grant execute on function public.delete_workspace(uuid, uuid, text, text, timestamptz)\nto service_role");
    expect(migration).not.toContain("grant execute on function public.delete_workspace(uuid, uuid, text, text, timestamptz)\nto authenticated");
  });

  it("captures exact storage paths before deletion behind a bounded service-only queue", () => {
    expect(storageCleanupMigration).toContain("create table private.workspace_storage_cleanup_jobs");
    expect(storageCleanupMigration).toContain("select distinct sv.storage_path");
    expect(storageCleanupMigration).toContain("sv.storage_path !~ ('^' || p_workspace_id::text");
    expect(storageCleanupMigration).toContain("attempt_count < 8");
    expect(storageCleanupMigration).toContain("last_error_code = 'lease_expired'");
    expect(storageCleanupMigration).toContain("'storage_cleanup_id', cleanup_id_value");
    expect(storageCleanupMigration).toContain("revoke all on function public.claim_workspace_storage_cleanup_jobs");
    expect(storageCleanupMigration).not.toContain("to authenticated;");
    expect(storageCleanupIndexMigration).toContain("on private.workspace_storage_cleanup_jobs(deletion_event_id)");
    expect(finalIntegrityMigration).toContain("revive_abandoned_storage_cleanup_jobs");
    expect(finalIntegrityMigration).toContain("interval '24 hours'");
  });

  it("passes tenant, actor, exact confirmation, and fresh password evidence to the atomic RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      id: workspaceId,
      name: "Acme Intelligence",
      slug: "acme-intelligence",
      deletion_event_id: eventId,
      storage_cleanup_id: cleanupId,
      deleted_at: "2026-08-16T12:00:01.000Z",
    }, error: null });
    const admin = { rpc } as unknown as SupabaseClient<Database>;

    await expect(deleteWorkspace(admin, {
      workspaceId,
      actorId,
      confirmation: "acme-intelligence",
      reauthenticationMethod: "password",
      reauthenticatedAt,
    })).resolves.toMatchObject({ id: workspaceId, deletion_event_id: eventId, storage_cleanup_id: cleanupId });
    expect(rpc).toHaveBeenCalledWith("delete_workspace", {
      p_workspace_id: workspaceId,
      p_actor_id: actorId,
      p_confirmation: "acme-intelligence",
      p_reauthentication_method: "password",
      p_reauthenticated_at: reauthenticatedAt,
    });
  });

  it("removes only the exact service-leased tenant path and marks that job complete", async () => {
    const objectPath = `${workspaceId}/project/source/object-notes.txt`;
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: 0, error: null })
      .mockResolvedValueOnce({ data: [{
        id: cleanupJobId,
        cleanup_id: cleanupId,
        workspace_id: workspaceId,
        bucket_id: "evidence-private",
        object_path: objectPath,
        attempt_count: 1,
      }], error: null })
      .mockResolvedValueOnce({ data: { id: cleanupJobId, status: "succeeded" }, error: null });
    const remove = vi.fn().mockResolvedValue({ data: [{ name: objectPath }], error: null });
    const from = vi.fn(() => ({ remove }));
    const admin = { rpc, storage: { from } } as unknown as SupabaseClient<Database>;

    await expect(processWorkspaceStorageCleanup(admin, {
      workerId: "workspace-delete:test",
      cleanupId,
      limit: 10,
    })).resolves.toEqual({ claimed: 1, succeeded: 1, deferred: 0, abandoned: 0 });
    expect(from).toHaveBeenCalledWith("evidence-private");
    expect(remove).toHaveBeenCalledWith([objectPath]);
    expect(rpc).toHaveBeenNthCalledWith(3, "complete_workspace_storage_cleanup_job", {
      p_job_id: cleanupJobId,
      p_worker_id: "workspace-delete:test",
    });
  });

  it("queues a bounded retry without returning or broadening a failed exact path", async () => {
    const objectPath = `${workspaceId}/project/source/object-notes.txt`;
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: 0, error: null })
      .mockResolvedValueOnce({ data: [{
        id: cleanupJobId,
        cleanup_id: cleanupId,
        workspace_id: workspaceId,
        bucket_id: "evidence-private",
        object_path: objectPath,
        attempt_count: 2,
      }], error: null })
      .mockResolvedValueOnce({ data: { id: cleanupJobId, status: "pending" }, error: null });
    const remove = vi.fn().mockResolvedValue({ data: null, error: { message: "provider detail" } });
    const admin = { rpc, storage: { from: vi.fn(() => ({ remove })) } } as unknown as SupabaseClient<Database>;

    const result = await processWorkspaceStorageCleanup(admin, { workerId: "worker:test" });
    expect(result).toEqual({ claimed: 1, succeeded: 0, deferred: 1, abandoned: 0 });
    expect(remove).toHaveBeenCalledWith([objectPath]);
    expect(rpc).toHaveBeenNthCalledWith(3, "fail_workspace_storage_cleanup_job", {
      p_job_id: cleanupJobId,
      p_worker_id: "worker:test",
      p_error_code: "storage_remove_failed",
      p_retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain(objectPath);
  });

  it("never sends a cross-tenant or prefix-like path to Storage", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: 0, error: null })
      .mockResolvedValueOnce({ data: [{
        id: cleanupJobId,
        cleanup_id: cleanupId,
        workspace_id: workspaceId,
        bucket_id: "evidence-private",
        object_path: "another-tenant/project/source/object.txt",
        attempt_count: 1,
      }], error: null })
      .mockResolvedValueOnce({ data: { id: cleanupJobId, status: "abandoned" }, error: null });
    const remove = vi.fn();
    const admin = { rpc, storage: { from: vi.fn(() => ({ remove })) } } as unknown as SupabaseClient<Database>;

    await expect(processWorkspaceStorageCleanup(admin, { workerId: "worker:test" }))
      .resolves.toEqual({ claimed: 1, succeeded: 0, deferred: 0, abandoned: 1 });
    expect(remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenNthCalledWith(3, "fail_workspace_storage_cleanup_job", expect.objectContaining({
      p_error_code: "invalid_storage_path",
      p_retryable: false,
    }));
  });

  it.each([
    ["42501", "forbidden"],
    ["P0002", "not_found"],
    ["22023", "confirmation_mismatch"],
    ["28000", "reauthentication_required"],
    ["2BP01", "deletion_unavailable"],
    ["XX000", "deletion_unavailable"],
  ])("maps database failure %s to %s", async (databaseCode, applicationCode) => {
    const admin = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: databaseCode } }) } as unknown as SupabaseClient<Database>;
    await expect(deleteWorkspace(admin, {
      workspaceId,
      actorId,
      confirmation: "acme-intelligence",
      reauthenticationMethod: "password",
      reauthenticatedAt,
    })).rejects.toMatchObject({ code: applicationCode });
  });

  it("fails closed when a successful RPC returns an invalid receipt", async () => {
    const admin = { rpc: vi.fn().mockResolvedValue({ data: { id: workspaceId }, error: null }) } as unknown as SupabaseClient<Database>;
    await expect(deleteWorkspace(admin, {
      workspaceId,
      actorId,
      confirmation: "acme-intelligence",
      reauthenticationMethod: "password",
      reauthenticatedAt,
    })).rejects.toMatchObject({ code: "deletion_unavailable" });
  });
});
