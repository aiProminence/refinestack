import { ApiProblem } from "@/lib/platform/api";
import { withApiRequest } from "@/lib/platform/api-handler";
import { cursorSecret, decodeCursor, encodeCursor, pageLimit } from "@/lib/platform/pagination";
import { ensureRun } from "@/lib/platform/routes";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  return withApiRequest(request, "read", async ({ admin, principal, url }) => {
    const { runId } = await context.params;
    const run = await ensureRun(admin, principal.workspaceId, runId);
    const limit = pageLimit(url.searchParams.get("limit"));
    const secret = cursorSecret();
    const cursor = decodeCursor(url.searchParams.get("cursor"), secret);
    let query = admin.from("observations")
      .select("id,project_id,run_id,question_id,run_item_id,provider,status,access_method,model_or_surface,provider_request_id,captured_at,answer_text,error_code")
      .eq("workspace_id", principal.workspaceId).eq("project_id", run.project_id).eq("run_id", run.id)
      .order("captured_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
    if (cursor) query = query.or(`captured_at.lt.${cursor.sort},and(captured_at.eq.${cursor.sort},id.lt.${cursor.id})`);
    const { data, error } = await query;
    if (error) throw new ApiProblem(503, "data_unavailable", "Observation data is temporarily unavailable.");
    const items = (data ?? []).slice(0, limit);
    const ids = items.map((item) => item.id);
    const [{ data: citations, error: citationError }, { data: classifications, error: classificationError }] = ids.length === 0
      ? [{ data: [], error: null }, { data: [], error: null }]
      : await Promise.all([
        admin.from("citations").select("id,observation_id,url,canonical_url,title,position,evidence_excerpt")
          .eq("workspace_id", principal.workspaceId).eq("project_id", run.project_id).in("observation_id", ids)
          .order("position", { ascending: true }),
        admin.from("brand_classifications")
          .select("id,observation_id,brand_version_id,mentioned,cited,shortlisted,explicitly_recommended,first_choice,rejected,rank,confidence,evidence_spans,rationale,review_status,created_at")
          .eq("workspace_id", principal.workspaceId).eq("project_id", run.project_id).in("observation_id", ids),
      ]);
    if (citationError || classificationError) throw new ApiProblem(503, "data_unavailable", "Observation evidence is temporarily unavailable.");
    const enriched = items.map((item) => ({
      ...item,
      citations: (citations ?? []).filter((citation) => citation.observation_id === item.id),
      classifications: (classifications ?? []).filter((classification) => classification.observation_id === item.id),
    }));
    const last = items.at(-1);
    return { data: { items: enriched, nextCursor: (data?.length ?? 0) > limit && last ? encodeCursor({ v: 1, sort: last.captured_at, id: last.id }, secret) : null } };
  });
}
