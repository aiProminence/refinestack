import { describe, expect, it } from "vitest";
import {
  createBrand,
  createProductRepository,
  getRunPreflight,
  getUsageSummary,
  listBrands,
  listPendingClassificationReviews,
  listQuestionSets,
  updateBrand,
} from "@/lib/db/repository";
import type { DbContext, ProductDbClient } from "@/lib/db/types";

type MockResponse = { data: unknown; error: unknown; count?: number | null };
type QueryCall = { table: string; operation: string; args: unknown[] };

class MockQuery implements PromiseLike<MockResponse> {
  constructor(
    private readonly table: string,
    private readonly response: MockResponse,
    private readonly calls: QueryCall[],
  ) {}

  private record(operation: string, ...args: unknown[]) {
    this.calls.push({ table: this.table, operation, args });
    return this;
  }

  select(...args: unknown[]) { return this.record("select", ...args); }
  insert(...args: unknown[]) { return this.record("insert", ...args); }
  update(...args: unknown[]) { return this.record("update", ...args); }
  delete(...args: unknown[]) { return this.record("delete", ...args); }
  eq(...args: unknown[]) { return this.record("eq", ...args); }
  in(...args: unknown[]) { return this.record("in", ...args); }
  gte(...args: unknown[]) { return this.record("gte", ...args); }
  order(...args: unknown[]) { return this.record("order", ...args); }
  limit(...args: unknown[]) { return this.record("limit", ...args); }
  is(...args: unknown[]) { return this.record("is", ...args); }
  gt(...args: unknown[]) { return this.record("gt", ...args); }

  maybeSingle() {
    this.record("maybeSingle");
    return Promise.resolve(this.response);
  }

  single() {
    this.record("single");
    return Promise.resolve(this.response);
  }

  then<TResult1 = MockResponse, TResult2 = never>(
    onfulfilled?: ((value: MockResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.response).then(onfulfilled, onrejected);
  }
}

function context(responses: Record<string, MockResponse[]>) {
  const calls: QueryCall[] = [];
  const client = {
    from(table: string) {
      const response = responses[table]?.shift();
      if (!response) throw new Error(`Missing mock response for ${table}`);
      return new MockQuery(table, response, calls);
    },
  } as unknown as ProductDbClient;
  const ctx: DbContext = {
    client,
    actor: { userId: "user-a", workspaceId: "workspace-a", role: "analyst" },
  };
  return { ctx, calls };
}

const membership = { data: { role: "analyst" }, error: null };
const project = { data: { id: "project-a" }, error: null };

function expectTenantAndProjectScope(calls: QueryCall[], table: string) {
  const tableCalls = calls.filter((call) => call.table === table && call.operation === "eq");
  expect(tableCalls).toContainEqual({ table, operation: "eq", args: ["workspace_id", "workspace-a"] });
  expect(tableCalls).toContainEqual({ table, operation: "eq", args: ["project_id", "project-a"] });
}

describe("UI-safe product repository reads", () => {
  it("reconciles workspace-wide actual usage and active reservations against hard limits", async () => {
    const { ctx, calls } = context({
      workspace_members: [membership],
      projects: [project],
      usage_events: [{ data: [{ call_count: 4, input_tokens: 120, output_tokens: 30, estimated_cost_usd: 0.4, usage_complete: false, billing_ambiguous: true }], error: null }],
      runs: [{ data: [{ reserved_call_count: 3, reserved_cost_usd: 0.15 }], error: null }],
      workspace_quotas: [{ data: { monthly_call_limit: 100, monthly_cost_limit_usd: 10 }, error: null }],
    });

    await expect(getUsageSummary(ctx, "project-a")).resolves.toEqual({
      calls: 4, inputTokens: 120, outputTokens: 30, estimatedCostUsd: 0.4,
      reservedCalls: 3, reservedCostUsd: 0.15, callLimit: 100, costLimitUsd: 10,
      ambiguousEventCount: 1, incompleteEventCount: 1, ambiguousCallCount: 4,
    });
    expect(calls.filter((call) => call.table === "usage_events" && call.operation === "eq"))
      .toEqual([{ table: "usage_events", operation: "eq", args: ["workspace_id", "workspace-a"] }]);
    expect(calls.filter((call) => call.table === "runs" && call.operation === "in"))
      .toContainEqual({ table: "runs", operation: "in", args: ["status", ["queued", "running"]] });
  });

  it("returns ordered question sets with tenant-scoped version membership", async () => {
    const { ctx, calls } = context({
      workspace_members: [membership],
      projects: [project],
      question_sets: [{ data: [
        { id: "set-2", name: "Current", version: 2, cohort_hash: "hash-2", created_at: "2026-08-16T02:00:00Z" },
        { id: "set-1", name: "Baseline", version: 1, cohort_hash: "hash-1", created_at: "2026-08-15T02:00:00Z" },
      ], error: null }],
      question_set_items: [{ data: [
        { question_set_id: "set-2", question_version_id: "qv-2", position: 1 },
        { question_set_id: "set-2", question_version_id: "qv-3", position: 2 },
        { question_set_id: "set-1", question_version_id: "qv-1", position: 1 },
      ], error: null }],
    });

    await expect(listQuestionSets(ctx, "project-a")).resolves.toEqual([
      { id: "set-2", name: "Current", version: 2, cohortHash: "hash-2", createdAt: "2026-08-16T02:00:00Z", questionVersionIds: ["qv-2", "qv-3"] },
      { id: "set-1", name: "Baseline", version: 1, cohortHash: "hash-1", createdAt: "2026-08-15T02:00:00Z", questionVersionIds: ["qv-1"] },
    ]);
    expectTenantAndProjectScope(calls, "question_sets");
    expectTenantAndProjectScope(calls, "question_set_items");
  });

  it("builds a run preflight from current active versions, healthy providers, and quota", async () => {
    const { ctx, calls } = context({
      workspace_members: [membership],
      projects: [project],
      questions: [{ data: [
        { id: "question-1", current_version: 2, current_prompt: "Which verified option best fits enterprise buyers?", question_type: "category_discovery", persona: "Enterprise buyer", stage: "Discovery", market: "MY", locale: "en-MY", rationale: "Measures the enterprise discovery decision." },
        { id: "question-2", current_version: 1, current_prompt: "How should small teams compare verified providers?", question_type: "brand_comparison", persona: "Small team buyer", stage: "Evaluation", market: "MY", locale: "en-MY", rationale: "Measures the small team evaluation decision." },
      ], error: null }],
      question_versions: [{ data: [
        { id: "qv-old", question_id: "question-1", version: 1 },
        { id: "qv-2", question_id: "question-1", version: 2 },
        { id: "qv-1", question_id: "question-2", version: 1 },
      ], error: null }],
      provider_connections: [{ data: [
        { provider: "openai", enabled: true, health_state: "healthy", remediation: null, last_checked_at: "2026-08-16T01:00:00Z" },
        { provider: "claude", enabled: true, health_state: "degraded", remediation: "Retry health check.", last_checked_at: "2026-08-16T01:00:00Z" },
        { provider: "google_ai_overview", enabled: false, health_state: "unchecked", remediation: "Complete a successful health check.", last_checked_at: null },
      ], error: null }],
      provider_budget_caps: [{ data: [
        { provider: "openai", max_calls_per_capture: 3, max_cost_per_capture_usd: 0.15, rationale: "One response plus bounded retries.", updated_at: "2026-08-16T00:00:00Z" },
      ], error: null }],
      usage_events: [{ data: [{ call_count: 90, estimated_cost_usd: 4.2 }], error: null }],
      workspace_quotas: [{ data: { monthly_call_limit: 100, monthly_cost_limit_usd: 5 }, error: null }],
      runs: [{ data: [{ reserved_call_count: 1, reserved_cost_usd: 0.1 }], error: null }],
      question_sets: [{ data: [
        { id: "set-current", name: "Current", version: 1, cohort_hash: "hash", created_at: "2026-08-16T02:00:00Z" },
      ], error: null }],
      question_set_items: [{ data: [
        { question_set_id: "set-current", question_version_id: "qv-1", position: 1 },
        { question_set_id: "set-current", question_version_id: "qv-2", position: 2 },
      ], error: null }],
    });

    const result = await getRunPreflight(ctx, "project-a");
    expect(result.activeQuestionVersionIds).toEqual(["qv-1", "qv-2"]);
    expect(result.activeQuestionSetId).toBe("set-current");
    expect(result.selectedProviderKeys).toEqual(["openai"]);
    expect(result.estimatedCaptureCount).toBe(2);
    expect(result.providerBudgetAssumptions).toEqual([{
      provider: "openai",
      maxCallsPerCapture: 3,
      maxCostPerCaptureUsd: 0.15,
      rationale: "One response plus bounded retries.",
      updatedAt: "2026-08-16T00:00:00Z",
    }]);
    expect(result.providersMissingBudgetCaps).toEqual([]);
    expect(result.quota).toEqual({
      configured: true,
      callsUsed: 91,
      callLimit: 100,
      callsRemaining: 9,
      requiredCalls: 6,
      callShortfall: 0,
      costUsedUsd: 4.3,
      costLimitUsd: 5,
      costRemainingUsd: 0.7,
      requiredCostUsd: 0.3,
      costShortfallUsd: 0,
      ready: true,
      reason: null,
    });
    for (const table of ["questions", "question_versions", "question_sets", "question_set_items"]) {
      expectTenantAndProjectScope(calls, table);
    }
    for (const table of ["usage_events", "runs"]) {
      expect(calls.filter((call) => call.table === table && call.operation === "eq"))
        .toContainEqual({ table, operation: "eq", args: ["workspace_id", "workspace-a"] });
    }
    expect(calls.filter((call) => call.table === "provider_connections" && call.operation === "eq"))
      .toContainEqual({ table: "provider_connections", operation: "eq", args: ["workspace_id", "workspace-a"] });
    expect(calls.filter((call) => call.table === "usage_events" && call.operation === "eq"))
      .not.toContainEqual({ table: "usage_events", operation: "eq", args: ["project_id", "project-a"] });
  });

  it("fails closed when a healthy selected provider has no authoritative budget cap", async () => {
    const { ctx } = context({
      workspace_members: [membership],
      projects: [project],
      questions: [{ data: [{ id: "question-1", current_version: 1, current_prompt: "Which verified provider best fits enterprise buyers?", question_type: "category_discovery", persona: "Enterprise buyer", stage: "Discovery", market: "MY", locale: "en-MY", rationale: "Measures the enterprise discovery decision." }], error: null }],
      provider_connections: [{ data: [{
        provider: "openai", enabled: true, health_state: "healthy", remediation: null,
        last_checked_at: "2026-08-16T01:00:00Z",
      }], error: null }],
      provider_budget_caps: [{ data: [], error: null }],
      usage_events: [{ data: [], error: null }],
      workspace_quotas: [{ data: { monthly_call_limit: 100, monthly_cost_limit_usd: 10 }, error: null }],
      runs: [{ data: [], error: null }],
      question_sets: [{ data: [], error: null }],
      question_versions: [{ data: [{ id: "qv-1", question_id: "question-1", version: 1 }], error: null }],
    });

    const result = await getRunPreflight(ctx, "project-a");
    expect(result.providersMissingBudgetCaps).toEqual(["openai"]);
    expect(result.providerBudgetAssumptions).toEqual([]);
    expect(result.quota).toMatchObject({
      ready: false,
      reason: "provider_budget_unavailable",
      requiredCalls: 0,
      requiredCostUsd: 0,
    });
  });

  it("admits one bounded first capture for an enabled provider whose health is still unchecked", async () => {
    const { ctx } = context({
      workspace_members: [membership],
      projects: [project],
      questions: [{ data: [{ id: "question-1", current_version: 1, current_prompt: "Which verified provider best fits enterprise buyers?", question_type: "category_discovery", persona: "Enterprise buyer", stage: "Discovery", market: "MY", locale: "en-MY", rationale: "Measures the enterprise discovery decision." }], error: null }],
      provider_connections: [{ data: [{
        provider: "openai", enabled: true, health_state: "unchecked",
        remediation: "Awaiting the first successful capture.", last_checked_at: null,
      }], error: null }],
      provider_budget_caps: [{ data: [{
        provider: "openai", max_calls_per_capture: 3, max_cost_per_capture_usd: 0.15,
        rationale: "Bounded capture.", updated_at: "2026-08-16T00:00:00Z",
      }], error: null }],
      usage_events: [{ data: [], error: null }],
      workspace_quotas: [{ data: { monthly_call_limit: 100, monthly_cost_limit_usd: 10 }, error: null }],
      runs: [{ data: [], error: null }],
      question_sets: [{ data: [], error: null }],
      question_versions: [{ data: [{ id: "qv-1", question_id: "question-1", version: 1 }], error: null }],
    });

    const result = await getRunPreflight(ctx, "project-a");
    expect(result.selectedProviderKeys).toEqual(["openai"]);
    expect(result.quota).toMatchObject({ ready: true, reason: null, requiredCalls: 3, requiredCostUsd: 0.15 });
  });

  it("blocks when workspace-wide actual usage and active reservations exceed call and cost headroom", async () => {
    const { ctx } = context({
      workspace_members: [membership],
      projects: [project],
      questions: [{ data: [{ id: "question-1", current_version: 1, current_prompt: "Which verified provider best fits enterprise buyers?", question_type: "category_discovery", persona: "Enterprise buyer", stage: "Discovery", market: "MY", locale: "en-MY", rationale: "Measures the enterprise discovery decision." }], error: null }],
      provider_connections: [{ data: [{
        provider: "openai", enabled: true, health_state: "healthy", remediation: null,
        last_checked_at: "2026-08-16T01:00:00Z",
      }], error: null }],
      provider_budget_caps: [{ data: [{
        provider: "openai", max_calls_per_capture: 3, max_cost_per_capture_usd: 0.15,
        rationale: "Bounded capture.", updated_at: "2026-08-16T00:00:00Z",
      }], error: null }],
      usage_events: [{ data: [{ call_count: 8, estimated_cost_usd: 0.8 }], error: null }],
      workspace_quotas: [{ data: { monthly_call_limit: 10, monthly_cost_limit_usd: 1 }, error: null }],
      runs: [{ data: [{ reserved_call_count: 1, reserved_cost_usd: 0.1 }], error: null }],
      question_sets: [{ data: [], error: null }],
      question_versions: [{ data: [{ id: "qv-1", question_id: "question-1", version: 1 }], error: null }],
    });

    const result = await getRunPreflight(ctx, "project-a");
    expect(result.quota).toMatchObject({
      callsUsed: 9,
      callsRemaining: 1,
      requiredCalls: 3,
      callShortfall: 2,
      costUsedUsd: 0.9,
      costRemainingUsd: 0.1,
      requiredCostUsd: 0.15,
      costShortfallUsd: 0.05,
      ready: false,
      reason: "insufficient_calls_and_cost",
    });
  });

  it("returns pending review evidence and a facts-only safe before value", async () => {
    const { ctx, calls } = context({
      workspace_members: [membership],
      projects: [project],
      brand_classifications: [{ data: [{
        id: "classification-1", brand_version_id: "brand-version-1", observation_id: "observation-1",
        mentioned: true, cited: false, shortlisted: true, explicitly_recommended: false,
        first_choice: false, rejected: false, rank: 2, confidence: 0.61,
        evidence_spans: [{ start: 4, end: 12 }], rationale: "The brand appears in a shortlist.",
      }], error: null }],
      classification_reviews: [{ data: [], error: null }],
      observations: [{ data: [{
        id: "observation-1", answer_text: "A captured answer", provider: "claude",
        access_method: "api", model_or_surface: "claude-sonnet", captured_at: "2026-08-16T03:00:00Z",
      }], error: null }],
    });

    const result = await listPendingClassificationReviews(ctx, "project-a");
    expect(result).toHaveLength(1);
    expect(result[0]?.beforeValue).toEqual({
      mentioned: true,
      cited: false,
      shortlisted: true,
      explicitlyRecommended: false,
      firstChoice: false,
      rejected: false,
      rank: 2,
    });
    expect(result[0]?.observation).toMatchObject({
      id: "observation-1", provider: "claude", accessMethod: "api", answerText: "A captured answer",
    });
    expectTenantAndProjectScope(calls, "brand_classifications");
    expectTenantAndProjectScope(calls, "observations");
  });
});

describe("tenant-scoped brand repository operations", () => {
  it("lists brands only inside the selected tenant project", async () => {
    const brands = [{ id: "brand-1", workspace_id: "workspace-a", project_id: "project-a", role: "primary" }];
    const { ctx, calls } = context({
      workspace_members: [membership],
      projects: [project],
      brands: [{ data: brands, error: null }],
    });
    await expect(listBrands(ctx, "project-a")).resolves.toEqual(brands);
    expectTenantAndProjectScope(calls, "brands");
  });

  it("creates a primary brand with synchronized legacy and Release 1 role fields", async () => {
    const created = { id: "brand-1", workspace_id: "workspace-a", project_id: "project-a", role: "primary", is_primary: true };
    const { ctx, calls } = context({
      workspace_members: [membership],
      projects: [project],
      brands: [{ data: created, error: null }],
    });
    await expect(createBrand(ctx, {
      projectId: "project-a", name: "Acme", domain: "acme.example", role: "primary", market: "en-MY",
    })).resolves.toEqual(created);
    expect(calls).toContainEqual({
      table: "brands",
      operation: "insert",
      args: [{ workspace_id: "workspace-a", project_id: "project-a", name: "Acme", domain: "acme.example", role: "primary", is_primary: true, market: "en-MY" }],
    });
  });

  it("authorizes and scopes brand updates while synchronizing role fields", async () => {
    const updated = { id: "brand-1", workspace_id: "workspace-a", role: "competitor", is_primary: false };
    const { ctx, calls } = context({
      workspace_members: [membership],
      brands: [{ data: { id: "brand-1" }, error: null }, { data: updated, error: null }],
    });
    await expect(updateBrand(ctx, "brand-1", { role: "competitor" })).resolves.toEqual(updated);
    expect(calls).toContainEqual({ table: "brands", operation: "update", args: [{ role: "competitor", is_primary: false }] });
    const brandEquals = calls.filter((call) => call.table === "brands" && call.operation === "eq");
    expect(brandEquals.filter((call) => call.args[0] === "workspace_id")).toHaveLength(2);
    expect(brandEquals.filter((call) => call.args[0] === "id")).toHaveLength(2);
  });

  it("exposes the new UI reads and brand mutations on the repository facade", () => {
    const { ctx } = context({});
    const repository = createProductRepository(ctx);
    expect(repository).toMatchObject({
      getRunPreflight: expect.any(Function),
      listQuestionSets: expect.any(Function),
      listPendingClassificationReviews: expect.any(Function),
      listBrands: expect.any(Function),
      createBrand: expect.any(Function),
      updateBrand: expect.any(Function),
    });
  });
});
