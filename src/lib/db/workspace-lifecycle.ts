import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/types/database";

const deletionResultSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  deletion_event_id: z.string().uuid(),
  storage_cleanup_id: z.string().uuid(),
  deleted_at: z.string().datetime({ offset: true }),
}).strict();

const storageCleanupJobSchema = z.object({
  id: z.string().uuid(),
  cleanup_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  bucket_id: z.literal("evidence-private"),
  object_path: z.string().min(3).max(1_024),
  attempt_count: z.number().int().min(1).max(8),
}).strict();

export type WorkspaceDeletionResult = z.infer<typeof deletionResultSchema>;
export type WorkspaceDeletionFailure =
  | "forbidden"
  | "not_found"
  | "confirmation_mismatch"
  | "reauthentication_required"
  | "deletion_unavailable";

export class WorkspaceDeletionError extends Error {
  constructor(readonly code: WorkspaceDeletionFailure, message: string) {
    super(message);
    this.name = "WorkspaceDeletionError";
  }
}

type DeleteWorkspaceRpc = (
  name: "delete_workspace",
  args: {
    p_workspace_id: string;
    p_actor_id: string;
    p_confirmation: string;
    p_reauthentication_method: "password" | "otp";
    p_reauthenticated_at: string;
  },
) => Promise<{ data: unknown; error: { code?: string } | null }>;

type ClaimStorageCleanupRpc = (
  name: "claim_workspace_storage_cleanup_jobs",
  args: { p_worker_id: string; p_limit: number; p_lease_seconds: number; p_cleanup_id: string | null },
) => Promise<{ data: unknown; error: { code?: string } | null }>;

type ReviveStorageCleanupRpc = (
  name: "revive_abandoned_storage_cleanup_jobs",
  args: { p_now: string; p_limit: number },
) => Promise<{ data: unknown; error: { code?: string } | null }>;

type CompleteStorageCleanupRpc = (
  name: "complete_workspace_storage_cleanup_job",
  args: { p_job_id: string; p_worker_id: string },
) => Promise<{ data: unknown; error: { code?: string } | null }>;

type FailStorageCleanupRpc = (
  name: "fail_workspace_storage_cleanup_job",
  args: { p_job_id: string; p_worker_id: string; p_error_code: string; p_retryable: boolean },
) => Promise<{ data: unknown; error: { code?: string } | null }>;

export async function deleteWorkspace(
  admin: SupabaseClient<Database>,
  input: {
    workspaceId: string;
    actorId: string;
    confirmation: string;
    reauthenticationMethod: "password" | "otp";
    reauthenticatedAt: string;
  },
): Promise<WorkspaceDeletionResult> {
  const rpc = admin.rpc as unknown as DeleteWorkspaceRpc;
  const { data, error } = await rpc("delete_workspace", {
    p_workspace_id: input.workspaceId,
    p_actor_id: input.actorId,
    p_confirmation: input.confirmation,
    p_reauthentication_method: input.reauthenticationMethod,
    p_reauthenticated_at: input.reauthenticatedAt,
  });

  if (error?.code === "42501") {
    throw new WorkspaceDeletionError("forbidden", "Only a current workspace owner can delete this workspace.");
  }
  if (error?.code === "P0002" || error?.code === "02000") {
    throw new WorkspaceDeletionError("not_found", "The workspace no longer exists.");
  }
  if (error?.code === "22023") {
    throw new WorkspaceDeletionError("confirmation_mismatch", "The workspace confirmation does not match exactly.");
  }
  if (error?.code === "28000") {
    throw new WorkspaceDeletionError("reauthentication_required", "Fresh password verification is required.");
  }
  if (error) {
    throw new WorkspaceDeletionError("deletion_unavailable", "Workspace deletion is temporarily unavailable.");
  }

  const parsed = deletionResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new WorkspaceDeletionError("deletion_unavailable", "Workspace deletion is temporarily unavailable.");
  }
  return parsed.data;
}

export type WorkspaceStorageCleanupResult = {
  claimed: number;
  succeeded: number;
  deferred: number;
  abandoned: number;
};

function tenantScopedExactPath(workspaceId: string, objectPath: string) {
  if (!objectPath.startsWith(`${workspaceId}/`) || objectPath.startsWith("/") || objectPath.endsWith("/")) return false;
  const segments = objectPath.split("/");
  return segments.length === 4
    && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Removes only paths returned by the service-only queue lease. Each object is
 * acknowledged atomically after the Storage API succeeds; failures are left
 * pending for the database-controlled bounded retry schedule.
 */
export async function processWorkspaceStorageCleanup(
  admin: SupabaseClient<Database>,
  input: { workerId: string; limit?: number; leaseSeconds?: number; cleanupId?: string },
): Promise<WorkspaceStorageCleanupResult> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 10)));
  const leaseSeconds = Math.max(60, Math.min(3_600, Math.trunc(input.leaseSeconds ?? 300)));
  const revive = admin.rpc as unknown as ReviveStorageCleanupRpc;
  const revival = await revive("revive_abandoned_storage_cleanup_jobs", {
    p_now: new Date().toISOString(),
    p_limit: Math.max(limit, 100),
  });
  if (revival.error) throw new WorkspaceDeletionError("deletion_unavailable", "Stored evidence cleanup is temporarily unavailable.");
  const claim = admin.rpc as unknown as ClaimStorageCleanupRpc;
  const { data, error } = await claim("claim_workspace_storage_cleanup_jobs", {
    p_worker_id: input.workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
    p_cleanup_id: input.cleanupId ?? null,
  });
  if (error) throw new WorkspaceDeletionError("deletion_unavailable", "Stored evidence cleanup is temporarily unavailable.");
  const parsed = z.array(storageCleanupJobSchema).safeParse(data);
  if (!parsed.success) throw new WorkspaceDeletionError("deletion_unavailable", "Stored evidence cleanup is temporarily unavailable.");

  const result: WorkspaceStorageCleanupResult = { claimed: parsed.data.length, succeeded: 0, deferred: 0, abandoned: 0 };
  const complete = admin.rpc as unknown as CompleteStorageCleanupRpc;
  const fail = admin.rpc as unknown as FailStorageCleanupRpc;

  for (const job of parsed.data) {
    const safePath = tenantScopedExactPath(job.workspace_id, job.object_path);
    let removalFailed = !safePath;
    if (safePath) {
      const removal = await admin.storage.from(job.bucket_id).remove([job.object_path]);
      removalFailed = Boolean(removal.error);
    }

    if (!removalFailed) {
      const completion = await complete("complete_workspace_storage_cleanup_job", {
        p_job_id: job.id,
        p_worker_id: input.workerId,
      });
      if (completion.error) {
        result.deferred += 1;
      } else {
        result.succeeded += 1;
      }
      continue;
    }

    const retryable = safePath;
    const failure = await fail("fail_workspace_storage_cleanup_job", {
      p_job_id: job.id,
      p_worker_id: input.workerId,
      p_error_code: safePath ? "storage_remove_failed" : "invalid_storage_path",
      p_retryable: retryable,
    });
    if (failure.error) {
      result.deferred += 1;
    } else if (!retryable || job.attempt_count >= 8) {
      result.abandoned += 1;
    } else {
      result.deferred += 1;
    }
  }
  return result;
}
