import { ApiProblem } from "@/lib/platform/api";
import { withApiRequest } from "@/lib/platform/api-handler";
import { ensureRun } from "@/lib/platform/routes";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  return withApiRequest(request, "read", async ({ admin, principal }) => {
    const { runId } = await context.params;
    const run = await ensureRun(admin, principal.workspaceId, runId);
    const { data: items, error } = await admin.from("run_items")
      .select("id,question_version_id,provider,locale,market,status,attempt_count,max_attempts,last_error_code,started_at,completed_at,created_at")
      .eq("workspace_id", principal.workspaceId).eq("project_id", run.project_id).eq("run_id", run.id)
      .order("created_at", { ascending: true });
    if (error) throw new ApiProblem(503, "data_unavailable", "Run data is temporarily unavailable.");
    return { data: { ...run, items: items ?? [] } };
  });
}
