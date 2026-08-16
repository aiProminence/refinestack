import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/types/database";
import { ApiProblem } from "./api";

const cancellationResultSchema = z.object({
  id: z.string().uuid(),
  status: z.literal("cancelled"),
  cancelled_at: z.string().datetime({ offset: true }),
  cancellation_reason: z.string().nullable(),
  replayed: z.boolean(),
}).strict();

export type CancellationResult = z.infer<typeof cancellationResultSchema>;

type CancelRunRpc = (
  name: "cancel_monitoring_run",
  args: { p_workspace_id: string; p_run_id: string; p_actor_id: string; p_reason: string },
) => Promise<{ data: unknown; error: { code?: string } | null }>;

/**
 * Uses the database RPC as the sole state-transition boundary. The RPC is
 * responsible for authorization, atomic job cancellation, auditing and replay.
 */
export async function cancelMonitoringRun(
  admin: SupabaseClient<Database>,
  input: { workspaceId: string; runId: string; actorId: string; reason: string },
): Promise<CancellationResult> {
  const cancelRunRpc = admin.rpc as unknown as CancelRunRpc;
  const { data, error } = await cancelRunRpc("cancel_monitoring_run", {
    p_workspace_id: input.workspaceId,
    p_run_id: input.runId,
    p_actor_id: input.actorId,
    p_reason: input.reason,
  });

  if (error?.code === "42501") {
    throw new ApiProblem(403, "forbidden", "Your current workspace role cannot cancel runs.");
  }
  if (error?.code === "P0002" || error?.code === "02000") {
    throw new ApiProblem(404, "not_found", "The requested resource was not found.");
  }
  if (error?.code === "55000") {
    throw new ApiProblem(409, "run_not_cancellable", "Only queued or running runs can be cancelled.");
  }
  if (error?.code === "22023") {
    throw new ApiProblem(422, "validation_failed", "Give a cancellation reason between 3 and 500 characters.");
  }
  if (error) {
    throw new ApiProblem(503, "cancellation_unavailable", "Run cancellation is temporarily unavailable.");
  }

  const parsed = cancellationResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiProblem(503, "cancellation_unavailable", "Run cancellation is temporarily unavailable.");
  }
  return parsed.data;
}
