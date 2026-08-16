import { describe, expect, it } from "vitest";
import { draftEvidenceBackedAction, evaluateQuestionQuality, findDuplicateQuestionGroups, preflightCost, questionSimilarity } from "@/lib/ai";

describe("question quality", () => {
  it("normalizes multilingual spacing and finds semantic token duplicates", () => {
    expect(questionSimilarity("Which CRM is best for a small team?", "Which CRM is best for small teams?")).toBeGreaterThan(0.6);
    expect(findDuplicateQuestionGroups([{ id: "a", text: "Which CRM is best for a small team?" }, { id: "b", text: "Which CRM is best for a small team?" }, { id: "c", text: "¿Qué proveedor tiene buen soporte?" }])).toEqual([["a", "b"]]);
  });

  it("identifies leading, brand-loaded, duplicate, short, and malformed questions", () => {
    const result = evaluateQuestionQuality("Obviously Acme?", { trackedBrands: ["Acme"], knownQuestions: ["Obviously Acme?"] });
    expect(result.issues).toEqual(expect.arrayContaining(["too_short", "leading", "brand_loaded", "duplicate"]));
    expect(evaluateQuestionQuality("   ").score).toBe(0);
  });
});

describe("cost preflight", () => {
  it("computes calls and token plus fixed costs", () => {
    const result = preflightCost(10, [{ provider: "openai", available: true, estimatedInputTokens: 1000, estimatedOutputTokens: 500, inputPerMillionUsd: 2, outputPerMillionUsd: 8, fixedCostPerRequestUsd: 0.01 }], 1);
    expect(result).toMatchObject({ callCount: 10, estimatedCostUsd: 0.16, blocked: false });
  });

  it("blocks unavailable providers, unknown price, zero questions, and budget overruns", () => {
    expect(preflightCost(0, [{ provider: "claude", available: false }]).blocked).toBe(true);
    expect(preflightCost(1, [{ provider: "openai", available: true }]).reasons).toContain("Pricing or token assumptions are missing for at least one provider.");
    expect(preflightCost(10, [{ provider: "google_ai_overview", available: true, fixedCostPerRequestUsd: 1 }], 2).blocked).toBe(true);
  });

  it("prices token usage for every request and reports an exact budget shortfall", () => {
    const result = preflightCost(2, [{ provider: "openai", available: true, requestsPerQuestion: 3, estimatedInputTokens: 1_000_000, estimatedOutputTokens: 0, inputPerMillionUsd: 1, outputPerMillionUsd: 1 }], 5);
    expect(result).toMatchObject({ callCount: 6, estimatedCostUsd: 6, blocked: true, budgetShortfallUsd: 1 });
  });

  it("does not treat a partial fixed-only OpenAI estimate as complete", () => {
    expect(preflightCost(1, [{ provider: "openai", available: true, fixedCostPerRequestUsd: 0.01 }])).toMatchObject({ blocked: true, estimatedCostUsd: null });
  });
});

describe("evidence-backed actions", () => {
  it("does not draft from unsupported observations", () => {
    expect(draftEvidenceBackedAction([{ id: "f", questionId: "q", kind: "citation_gap", observation: "gap", provider: "openai" }])).toBeNull();
  });

  it("links every action to evidence and avoids causal certainty", () => {
    const action = draftEvidenceBackedAction([{ id: "f1", questionId: "q1", kind: "citation_gap", observation: "No owned citation", answerExcerpt: "Third party only", citationUrls: ["https://third.test"], provider: "openai" }]);
    expect(action).toMatchObject({ evidenceFindingIds: ["f1"], affectedQuestionIds: ["q1"] });
    expect(action?.rationale).toContain("hypothesis, not a causal claim");
  });
});
