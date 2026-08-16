import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbContext } from "@/lib/db/types";

const repository = vi.hoisted(() => ({
  listActions: vi.fn(), listEvidence: vi.fn(), listPendingClassificationReviews: vi.fn(), listRuns: vi.fn(),
}));
const analytics = vi.hoisted(() => ({ getIntelligenceAnalytics: vi.fn() }));
vi.mock("@/lib/db/repository", () => repository);
vi.mock("@/lib/db/analytics", () => analytics);

import { runOperatorQuery } from "@/lib/db/operator";

const ctx = { actor: { userId: "u", workspaceId: "w", role: "analyst" } } as DbContext;

describe("deterministic operator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("explains only stored deterministic metric output", async () => {
    analytics.getIntelligenceAnalytics.mockResolvedValue({
      metrics: { recommendation_share: { value: 0.25, numerator: 1, denominator: 4, formula: "slots / tracked slots", metricVersion: "2.0.0", cohortKey: "cohort_123", cohort: { to: "2026-08-16T00:00:00Z" } } },
      limitations: [{ message: "Two models are present." }],
    });
    await expect(runOperatorQuery(ctx, { projectId: "p", intent: "explain_metric", metricKey: "recommendation_share" })).resolves.toEqual(expect.objectContaining({
      heading: "Recommendation share",
      answer: "Recommendation share is 25.0% for cohort cohort_123.",
      facts: expect.arrayContaining([{ label: "Numerator", value: "1" }, { label: "Denominator", value: "4" }]),
      limitations: ["Two models are present."],
    }));
  });

  it("returns linked run status without generating advice", async () => {
    repository.listRuns.mockResolvedValue([{ id: "run-1", status: "partial", requested_capture_count: 3, created_at: "2026-08-16T00:00:00Z", started_at: "2026-08-16T00:01:00Z", completed_at: "2026-08-16T00:03:00Z" }]);
    const result = await runOperatorQuery(ctx, { projectId: "p", intent: "run_status" });
    expect(result.answer).toBe("The latest durable run is partial.");
    expect(result.links).toContainEqual({ label: "Open latest run", href: "/dashboard/runs/run-1" });
  });

  it("rejects intents outside the allowlist", async () => {
    await expect(runOperatorQuery(ctx, { projectId: "p", intent: "invent_strategy" as never })).rejects.toThrow(/Unsupported operator intent/);
    expect(repository.listActions).not.toHaveBeenCalled();
  });
});
