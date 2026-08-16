import { ApiProblem } from "@/lib/platform/api";
import { withApiRequest } from "@/lib/platform/api-handler";
import { toCsv } from "@/lib/platform/csv";
import { enforceCitationExportPolicy } from "@/lib/platform/export-policy";
import { ensureRun } from "@/lib/platform/routes";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const CSV_COLUMNS = [
  "observation_id", "question_id", "provider", "status", "access_method", "model_or_surface",
  "captured_at", "answer_text", "error_code", "citation_urls", "brand_version_id", "mentioned",
  "cited", "shortlisted", "explicitly_recommended", "first_choice", "rejected", "rank", "confidence",
  "review_status",
];

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  return withApiRequest(request, "export", async ({ admin, principal, url }) => {
    const { runId } = await context.params;
    const run = await ensureRun(admin, principal.workspaceId, runId);
    const format = url.searchParams.get("format") ?? "json";
    if (!new Set(["json", "csv"]).has(format)) throw new ApiProblem(400, "invalid_format", "Export format must be json or csv.");

    const [{ data: items, error: itemError }, { data: observations, error: observationError }] = await Promise.all([
      admin.from("run_items")
        .select("id,question_version_id,provider,locale,market,status,attempt_count,max_attempts,last_error_code,started_at,completed_at,created_at")
        .eq("workspace_id", principal.workspaceId).eq("project_id", run.project_id).eq("run_id", run.id)
        .order("created_at", { ascending: true }),
      admin.from("observations")
        .select("id,question_id,run_item_id,provider,status,access_method,model_or_surface,captured_at,answer_text,error_code")
        .eq("workspace_id", principal.workspaceId).eq("project_id", run.project_id).eq("run_id", run.id)
        .order("captured_at", { ascending: true }),
    ]);
    if (itemError || observationError) throw new ApiProblem(503, "export_unavailable", "Export data is temporarily unavailable.");
    const observationIds = (observations ?? []).map((observation) => observation.id);
    const untypedAdmin = admin as unknown as SupabaseClient;
    const [{ data: citations, error: citationError }, { data: classifications, error: classificationError }] = observationIds.length === 0
      ? [{ data: [], error: null }, { data: [], error: null }]
      : await Promise.all([
        untypedAdmin.from("citations")
          .select("id,observation_id,url,canonical_url,title,position,evidence_excerpt,source_version_id")
          .eq("workspace_id", principal.workspaceId).eq("project_id", run.project_id).in("observation_id", observationIds)
          .order("position", { ascending: true }),
        admin.from("brand_classifications")
          .select("id,observation_id,brand_version_id,mentioned,cited,shortlisted,explicitly_recommended,first_choice,rejected,rank,confidence,evidence_spans,rationale,review_status,created_at")
          .eq("workspace_id", principal.workspaceId).eq("project_id", run.project_id).in("observation_id", observationIds),
      ]);
    if (citationError || classificationError) throw new ApiProblem(503, "export_unavailable", "Export data is temporarily unavailable.");
    const exportCitations = await enforceCitationExportPolicy(admin, principal.workspaceId, run.project_id, citations ?? []);

    // Intentionally excluded: raw provider payloads, source content, credential fields, error messages and audit metadata.
    const payload = {
      schemaVersion: "2026-08-16",
      exportedAt: new Date().toISOString(),
      run,
      items: items ?? [],
      observations: (observations ?? []).map((observation) => ({
        ...observation,
        citations: exportCitations.filter((citation) => citation.observation_id === observation.id),
        classifications: (classifications ?? []).filter((classification) => classification.observation_id === observation.id),
      })),
    };
    const filename = `refinestack-run-${run.id}.${format}`;
    if (format === "json") return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` },
    });

    const rows = payload.observations.flatMap((observation) => {
      const base = {
        observation_id: observation.id,
        question_id: observation.question_id,
        provider: observation.provider,
        status: observation.status,
        access_method: observation.access_method,
        model_or_surface: observation.model_or_surface,
        captured_at: observation.captured_at,
        answer_text: observation.answer_text,
        error_code: observation.error_code,
        citation_urls: observation.citations.flatMap((citation) => citation.canonical_url ? [citation.canonical_url] : []).join(";"),
      };
      return observation.classifications.length > 0
        ? observation.classifications.map((classification) => ({ ...base, ...classification }))
        : [base];
    });
    return new Response(toCsv(CSV_COLUMNS, rows), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` },
    });
  });
}
