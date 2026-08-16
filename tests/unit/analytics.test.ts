import { describe, expect, it } from "vitest";
import { buildIntelligenceAnalytics, type AnalyticsDataset } from "@/lib/db/analytics";

const base: AnalyticsDataset = {
  observations: [
    { id: "obs-ok", workspace_id: "w", project_id: "p", run_id: "run-1", question_id: "q-1", run_item_id: "item-1", capture_attempt_id: null, provider: "openai", status: "succeeded", access_method: "api", model_or_surface: "gpt-test", provider_request_id: null, captured_at: "2026-08-16T01:00:00Z", raw_response: null, answer_text: "Acme is the best fit.", error_code: null, error_message: null },
    { id: "obs-failed", workspace_id: "w", project_id: "p", run_id: "run-1", question_id: "q-1", run_item_id: "item-2", capture_attempt_id: null, provider: "claude", status: "failed", access_method: "api", model_or_surface: "claude-test", provider_request_id: null, captured_at: "2026-08-16T01:01:00Z", raw_response: null, answer_text: null, error_code: "timeout", error_message: "Timed out" },
  ],
  runItems: [
    { id: "item-1", workspace_id: "w", project_id: "p", run_id: "run-1", question_version_id: "qv-1", provider: "openai", locale: "en-MY", market: "MY", status: "succeeded", idempotency_key: "i1", attempt_count: 1, max_attempts: 3, lease_owner: null, lease_started_at: null, lease_expires_at: null, last_error_code: null, available_at: "2026-08-16T00:00:00Z", started_at: null, completed_at: null, created_at: "2026-08-16T00:00:00Z" },
    { id: "item-2", workspace_id: "w", project_id: "p", run_id: "run-1", question_version_id: "qv-1", provider: "claude", locale: "en-MY", market: "MY", status: "failed", idempotency_key: "i2", attempt_count: 1, max_attempts: 3, lease_owner: null, lease_started_at: null, lease_expires_at: null, last_error_code: "timeout", available_at: "2026-08-16T00:00:00Z", started_at: null, completed_at: null, created_at: "2026-08-16T00:00:00Z" },
  ],
  runs: [{ id: "run-1", workspace_id: "w", project_id: "p", project_version_id: null, question_set_id: "set-1", schedule_id: null, status: "partial", requested_by: null, idempotency_key: "run", request_fingerprint: null, requested_capture_count: 2, reserved_call_count: 2, reserved_cost_usd: 0.2, estimated_max_cost_usd: null, started_at: null, completed_at: null, cancelled_at: null, cancellation_reason: null, created_at: "2026-08-16T00:00:00Z" }],
  brands: [
    { id: "brand-primary", workspace_id: "w", project_id: "p", name: "Acme", domain: "https://acme.example", market: "MY", is_primary: true, role: "primary", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" },
    { id: "brand-rival", workspace_id: "w", project_id: "p", name: "Rival", domain: "https://rival.example", market: "MY", is_primary: false, role: "competitor", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" },
  ],
  brandVersions: [
    { id: "bv-primary", workspace_id: "w", project_id: "p", brand_id: "brand-primary", version: 1, name: "Acme", domain: "https://acme.example", role: "primary", aliases: [], snapshot_hash: "a", created_by: null, created_at: "2026-08-01T00:00:00Z" },
    { id: "bv-rival", workspace_id: "w", project_id: "p", brand_id: "brand-rival", version: 1, name: "Rival", domain: "https://rival.example", role: "competitor", aliases: [], snapshot_hash: "b", created_by: null, created_at: "2026-08-01T00:00:00Z" },
  ],
  questionVersions: [{ id: "qv-1", workspace_id: "w", project_id: "p", question_id: "q-1", version: 1, prompt: "Which platform is best?", question_type: "recommended_vendors", persona: null, stage: null, market: "MY", locale: "en-MY", rationale: null, qualification: {}, snapshot_hash: "q", created_by: null, created_at: "2026-08-01T00:00:00Z" }],
  runBrandVersions: [
    { workspace_id: "w", project_id: "p", run_id: "run-1", brand_version_id: "bv-primary", role: "primary", position: 0, created_at: "2026-08-16T00:00:00Z" },
    { workspace_id: "w", project_id: "p", run_id: "run-1", brand_version_id: "bv-rival", role: "competitor", position: 1, created_at: "2026-08-16T00:00:00Z" },
  ],
  classifications: [
    { id: "class-primary", workspace_id: "w", project_id: "p", classification_run_id: "cr-1", observation_id: "obs-ok", brand_version_id: "bv-primary", mentioned: true, cited: true, shortlisted: true, explicitly_recommended: false, first_choice: false, rejected: false, rank: 2, confidence: 0.6, evidence_spans: [], rationale: "Shortlisted", review_status: "pending", created_at: "2026-08-16T01:00:01Z" },
    { id: "class-rival", workspace_id: "w", project_id: "p", classification_run_id: "cr-1", observation_id: "obs-ok", brand_version_id: "bv-rival", mentioned: true, cited: false, shortlisted: true, explicitly_recommended: false, first_choice: false, rejected: false, rank: 2, confidence: 0.95, evidence_spans: [], rationale: "Mentioned", review_status: "not_required", created_at: "2026-08-16T01:00:01Z" },
  ],
  classificationRuns: [{ id: "cr-1", workspace_id: "w", project_id: "p", observation_id: "obs-ok", classifier_name: "rules", classifier_version: "2", input_hash: "hash", created_at: "2026-08-16T01:00:01Z" }],
  reviews: [{ id: "review-1", workspace_id: "w", project_id: "p", classification_id: "class-primary", reviewer_id: "u", decision: "overridden", reason: "Explicit endorsement", before_value: {}, after_value: { mentioned: true, cited: true, shortlisted: true, explicitlyRecommended: true, firstChoice: true, rejected: false, rank: 1 }, created_at: "2026-08-16T01:02:00Z" }],
  citations: [
    { id: "cite-owned", workspace_id: "w", project_id: "p", observation_id: "obs-ok", url: "https://docs.acme.example/a", original_url: "https://docs.acme.example/a", canonical_url: "https://docs.acme.example/a", title: "Acme docs", position: 1, evidence_excerpt: "Retrieved supporting passage.", source_version_id: null, created_at: "2026-08-16T01:00:02Z" },
    { id: "cite-third", workspace_id: "w", project_id: "p", observation_id: "obs-ok", url: "https://analyst.example/a", original_url: "https://analyst.example/a", canonical_url: "https://analyst.example/a", title: "Analyst", position: 2, evidence_excerpt: null, source_version_id: null, created_at: "2026-08-16T01:00:02Z" },
  ],
};

describe("intelligence analytics", () => {
  it("uses reviewed facts, successful denominators, and owned citation domains", () => {
    const result = buildIntelligenceAnalytics("p", base);
    expect(result.metrics.capture_coverage).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(result.metrics.recommendation_rate).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(result.metrics.owned_citation_rate).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(result.metrics.evidence_support_rate).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(result.decisions[0]).toMatchObject({ outcome: "won", successfulCaptures: 1, eligibleCaptures: 1 });
    expect(result.citationDomains).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "docs.acme.example", owned: true, citations: 1 }),
      expect.objectContaining({ domain: "analyst.example", owned: false, citations: 1 }),
    ]));
    expect(result.brands.find((brand) => brand.brandId === "brand-primary")).toMatchObject({ recommendations: 1, firstChoices: 1 });
  });

  it("counts failed run items even when no observation was persisted", () => {
    const result = buildIntelligenceAnalytics("p", {
      ...base,
      observations: base.observations.filter((observation) => observation.status === "succeeded"),
    });
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: "run-item:item-2", observationId: null, status: "failed" }),
    ]));
    expect(result.metrics.capture_coverage).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
  });

  it("keeps failed attempts in coverage when filtering by the frozen competitor cohort", () => {
    const result = buildIntelligenceAnalytics("p", base, { competitorIds: ["brand-rival"] });
    expect(result.metrics.capture_coverage).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(result.records.map((record) => record.recordId)).toEqual(["obs-ok", "obs-failed"]);
  });

  it("excludes pending classifications and applies cohort filters", () => {
    const pending: AnalyticsDataset = { ...base, reviews: [] };
    const result = buildIntelligenceAnalytics("p", pending, { providers: ["openai"], markets: ["MY"] });
    expect(result.metrics.recommendation_rate).toMatchObject({ numerator: 0, denominator: 0, value: null });
    expect(result.limitations).toContainEqual(expect.objectContaining({ code: "classification_exclusions" }));
    expect(result.cohort.providers).toEqual(["openai"]);
  });

  it("marks a decision unstable when eligible captures disagree", () => {
    const second = structuredClone(base);
    second.observations = [{ ...base.observations[0]!, id: "obs-2", run_item_id: "item-3", captured_at: "2026-08-17T01:00:00Z" }];
    second.classifications = [
      { ...base.classifications[0]!, id: "class-primary-2", observation_id: "obs-2", review_status: "not_required", explicitly_recommended: false, first_choice: false, rank: null },
      { ...base.classifications[1]!, id: "class-rival-2", observation_id: "obs-2", explicitly_recommended: true, first_choice: true, rank: 1 },
    ];
    second.reviews = [];
    second.citations = [];
    const result = buildIntelligenceAnalytics("p", {
      ...base,
      observations: [base.observations[0]!, ...second.observations],
      runItems: [...base.runItems, { ...base.runItems[0]!, id: "item-3", idempotency_key: "i3" }],
      classifications: [...base.classifications.map((row) => row.id === "class-primary" ? { ...row, review_status: "not_required", explicitly_recommended: true, first_choice: true, rank: 1 } : row), ...second.classifications],
      reviews: [],
    });
    expect(result.decisions[0]?.outcome).toBe("unstable");
  });

  it("keeps rejected captures in recommendation denominators", () => {
    const rejectedObservation = { ...base.observations[0]!, id: "obs-rejected", run_item_id: "item-rejected", captured_at: "2026-08-16T02:00:00Z", answer_text: "Do not choose Acme." };
    const result = buildIntelligenceAnalytics("p", {
      ...base,
      observations: [base.observations[0]!, rejectedObservation],
      runItems: [...base.runItems, { ...base.runItems[0]!, id: "item-rejected", idempotency_key: "i-rejected" }],
      classifications: [
        ...base.classifications,
        { ...base.classifications[0]!, id: "class-rejected", observation_id: "obs-rejected", review_status: "not_required", explicitly_recommended: false, first_choice: false, rejected: true, rank: null },
        { ...base.classifications[1]!, id: "class-rival-rejected", observation_id: "obs-rejected" },
      ],
    });
    expect(result.metrics.recommendation_rate).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(result.metrics.first_choice_rate).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
  });

  it("uses frozen run brand roles and domains for historical analytics", () => {
    const result = buildIntelligenceAnalytics("p", {
      ...base,
      brands: base.brands.map((brand) => brand.id === "brand-primary"
        ? { ...brand, name: "Renamed later", domain: "https://changed.example", is_primary: false, role: "competitor" }
        : { ...brand, is_primary: true, role: "primary" }),
    });
    expect(result.metrics.recommendation_rate).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(result.metrics.owned_citation_rate).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(result.brands.find((brand) => brand.brandId === "brand-primary")).toMatchObject({ name: "Acme", domain: "https://acme.example", role: "primary" });
  });
});
