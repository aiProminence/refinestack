import { describe, expect, it } from "vitest";
import { getIntelligenceAnalytics } from "@/lib/db/analytics";
import type { DbContext, ProductDbClient } from "@/lib/db/types";

type Response = { data: unknown; error: unknown };
type Call = { table: string; operation: string; args: unknown[] };

class Query implements PromiseLike<Response> {
  constructor(private table: string, private response: Response, private calls: Call[]) {}
  private record(operation: string, ...args: unknown[]) { this.calls.push({ table: this.table, operation, args }); return this; }
  select(...args: unknown[]) { return this.record("select", ...args); }
  eq(...args: unknown[]) { return this.record("eq", ...args); }
  in(...args: unknown[]) { return this.record("in", ...args); }
  gte(...args: unknown[]) { return this.record("gte", ...args); }
  lte(...args: unknown[]) { return this.record("lte", ...args); }
  order(...args: unknown[]) { return this.record("order", ...args); }
  maybeSingle() { this.record("maybeSingle"); return Promise.resolve(this.response); }
  then<TResult1 = Response, TResult2 = never>(onfulfilled?: ((value: Response) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> { return Promise.resolve(this.response).then(onfulfilled, onrejected); }
}

function context(responses: Record<string, Response[]>) {
  const calls: Call[] = [];
  const client = { from(table: string) { const response = responses[table]?.shift(); if (!response) throw new Error(`Missing response for ${table}`); return new Query(table, response, calls); } } as unknown as ProductDbClient;
  const ctx: DbContext = { client, actor: { userId: "user-a", workspaceId: "workspace-a", role: "analyst" } };
  return { ctx, calls };
}

describe("analytics repository isolation", () => {
  it("scopes every classification and citation dependency to the actor workspace and project", async () => {
    const { ctx, calls } = context({
      workspace_members: [{ data: { role: "analyst" }, error: null }],
      projects: [{ data: { id: "project-a" }, error: null }],
      observations: [{ data: [{ id: "obs", workspace_id: "workspace-a", project_id: "project-a", run_id: "run", question_id: "q", run_item_id: "item", capture_attempt_id: null, provider: "openai", status: "succeeded", access_method: "api", model_or_surface: "model", provider_request_id: null, captured_at: "2026-08-16T00:00:00Z", raw_response: null, answer_text: "answer", error_code: null, error_message: null }], error: null }],
      brands: [{ data: [{ id: "brand", workspace_id: "workspace-a", project_id: "project-a", name: "Acme", domain: "https://acme.example", market: "MY", is_primary: true, role: "primary", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" }], error: null }],
      runs: [{ data: [{ id: "run", workspace_id: "workspace-a", project_id: "project-a", project_version_id: null, question_set_id: "set", schedule_id: null, status: "succeeded", requested_by: null, idempotency_key: "run", request_fingerprint: null, requested_capture_count: 1, reserved_call_count: 1, reserved_cost_usd: 0.1, estimated_max_cost_usd: null, started_at: null, completed_at: null, cancelled_at: null, cancellation_reason: null, created_at: "2026-08-16T00:00:00Z" }], error: null }],
      brand_classifications: [{ data: [{ id: "classification", workspace_id: "workspace-a", project_id: "project-a", classification_run_id: "cr", observation_id: "obs", brand_version_id: "bv", mentioned: true, cited: true, shortlisted: true, explicitly_recommended: true, first_choice: true, rejected: false, rank: 1, confidence: 1, evidence_spans: [], rationale: "explicit", review_status: "not_required", created_at: "2026-08-16T00:00:01Z" }], error: null }],
      citations: [{ data: [{ id: "citation", workspace_id: "workspace-a", project_id: "project-a", observation_id: "obs", url: "https://acme.example", original_url: "https://acme.example", canonical_url: "https://acme.example", title: null, position: 1, evidence_excerpt: null, created_at: "2026-08-16T00:00:01Z" }], error: null }],
      run_items: [{ data: [{ id: "item", workspace_id: "workspace-a", project_id: "project-a", run_id: "run", question_version_id: "qv", provider: "openai", locale: "en-MY", market: "MY", status: "succeeded", idempotency_key: "item", attempt_count: 1, max_attempts: 3, lease_owner: null, lease_expires_at: null, last_error_code: null, available_at: "2026-08-16T00:00:00Z", started_at: null, completed_at: null, created_at: "2026-08-16T00:00:00Z" }], error: null }],
      run_brand_versions: [{ data: [{ workspace_id: "workspace-a", project_id: "project-a", run_id: "run", brand_version_id: "bv", role: "primary", position: 0, created_at: "2026-08-16T00:00:00Z" }], error: null }],
      question_versions: [{ data: [{ id: "qv", workspace_id: "workspace-a", project_id: "project-a", question_id: "q", version: 1, prompt: "Question", question_type: "recommended_vendors", persona: null, stage: null, market: "MY", locale: "en-MY", rationale: null, qualification: {}, snapshot_hash: "q", created_by: null, created_at: "2026-08-01T00:00:00Z" }], error: null }],
      brand_versions: [{ data: [{ id: "bv", workspace_id: "workspace-a", project_id: "project-a", brand_id: "brand", version: 1, name: "Acme", domain: "https://acme.example", role: "primary", aliases: [], snapshot_hash: "b", created_by: null, created_at: "2026-08-01T00:00:00Z" }], error: null }],
      classification_runs: [{ data: [{ id: "cr", workspace_id: "workspace-a", project_id: "project-a", observation_id: "obs", classifier_name: "rules", classifier_version: "2", input_hash: "hash", created_at: "2026-08-16T00:00:01Z" }], error: null }],
      classification_reviews: [{ data: [], error: null }],
    });

    await expect(getIntelligenceAnalytics(ctx, "project-a")).resolves.toMatchObject({ metrics: { recommendation_rate: { value: 1 } } });
    for (const table of ["observations", "brands", "runs", "brand_classifications", "citations", "run_items", "run_brand_versions", "question_versions", "brand_versions", "classification_runs", "classification_reviews"]) {
      const equals = calls.filter((call) => call.table === table && call.operation === "eq");
      expect(equals).toContainEqual({ table, operation: "eq", args: ["workspace_id", "workspace-a"] });
      expect(equals).toContainEqual({ table, operation: "eq", args: ["project_id", "project-a"] });
    }
  });
});
