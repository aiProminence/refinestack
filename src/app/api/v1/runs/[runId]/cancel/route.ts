import { z } from "zod";
import { withApiRequest } from "@/lib/platform/api-handler";
import { cancelMonitoringRun } from "@/lib/platform/run-cancellation";
import { ensureRun, parseJsonBody } from "@/lib/platform/routes";

export const runtime = "nodejs";

const cancelRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return withApiRequest(request, "run", async ({ admin, principal }) => {
    const { runId } = await context.params;
    await ensureRun(admin, principal.workspaceId, runId);
    const body = await parseJsonBody(request, cancelRequestSchema);
    const result = await cancelMonitoringRun(admin, {
      workspaceId: principal.workspaceId,
      runId,
      actorId: principal.userId,
      reason: body.reason,
    });
    return { data: result };
  });
}
