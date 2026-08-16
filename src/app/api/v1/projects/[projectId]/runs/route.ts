import { ApiProblem } from "@/lib/platform/api";
import { withApiRequest } from "@/lib/platform/api-handler";
import { cursorSecret, decodeCursor, encodeCursor, pageLimit } from "@/lib/platform/pagination";
import { ensureProject, existingRunMatches, parseJsonBody, requireIdempotencyKey, runRequestSchema, withIdempotencyLock } from "@/lib/platform/routes";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  return withApiRequest(request, "read", async ({ admin, principal, url }) => {
    const { projectId } = await context.params;
    await ensureProject(admin, principal.workspaceId, projectId);
    const limit = pageLimit(url.searchParams.get("limit"));
    const secret = cursorSecret();
    const cursor = decodeCursor(url.searchParams.get("cursor"), secret);
    let query = admin.from("runs")
      .select("id,project_id,status,requested_capture_count,estimated_max_cost_usd,started_at,completed_at,cancelled_at,cancellation_reason,created_at")
      .eq("workspace_id", principal.workspaceId).eq("project_id", projectId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
    if (cursor) query = query.or(`created_at.lt.${cursor.sort},and(created_at.eq.${cursor.sort},id.lt.${cursor.id})`);
    const { data, error } = await query;
    if (error) throw new ApiProblem(503, "data_unavailable", "Run data is temporarily unavailable.");
    const items = (data ?? []).slice(0, limit);
    const last = items.at(-1);
    return { data: { items, nextCursor: (data?.length ?? 0) > limit && last ? encodeCursor({ v: 1, sort: last.created_at, id: last.id }, secret) : null } };
  });
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  return withApiRequest(request, "run", async ({ admin, principal }) => {
    const { projectId } = await context.params;
    await ensureProject(admin, principal.workspaceId, projectId);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = await parseJsonBody(request, runRequestSchema);
    return withIdempotencyLock(`${principal.workspaceId}:${idempotencyKey}`, async () => {
      const existing = await existingRunMatches(
        admin, principal.workspaceId, projectId, idempotencyKey,
        body.questionVersionIds, body.providers,
      );
      if (existing) return { data: { id: existing, replayed: true }, status: 200 };
      const { data, error } = await admin.rpc("create_monitoring_run", {
        p_workspace_id: principal.workspaceId,
        p_project_id: projectId,
        p_actor_id: principal.userId,
        p_question_version_ids: body.questionVersionIds,
        p_providers: body.providers,
        p_idempotency_key: idempotencyKey,
        p_estimated_max_cost_usd: null,
      });
      if (error || !data) {
        if (error?.code === "42501") throw new ApiProblem(403, "forbidden", "The current token owner cannot create runs.");
        if (error?.code === "23505") throw new ApiProblem(409, "idempotency_conflict", "This Idempotency-Key was already used with a different request.");
        if (error?.code === "23514" && /quota|budget|limit|cost/i.test(error.message ?? "")) throw new ApiProblem(409, "quota_exceeded", "The authoritative workspace call or cost quota is insufficient for this run.");
        if (["23503", "22023"].includes(error?.code ?? "")) throw new ApiProblem(422, "validation_failed", "The requested project, questions, or providers are invalid.");
        throw new ApiProblem(503, "run_not_created", "The run could not be created.");
      }
      return { data: { id: data, replayed: false }, status: 201, headers: { Location: `/api/v1/runs/${data}` } };
    });
  });
}
