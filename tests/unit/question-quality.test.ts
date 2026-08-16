import { describe, expect, it } from "vitest";
import { questionSimilarity, summarizeQuestionCoverage, validateQuestionDraft } from "@/lib/ai/questions";

const validDraft = {
  prompt: "Which CRM is best for a small revenue operations team?",
  questionType: "recommended_vendors",
  persona: "Revenue operations lead",
  stage: "Shortlisting",
  market: "United States",
  locale: "en-US",
  rationale: "Measures which vendors enter a small team shortlist.",
};

describe("question draft admission", () => {
  it("detects a near duplicate after harmless singular and plural wording changes", () => {
    const similarity = questionSimilarity(
      "Which CRM is best for a small revenue operations team?",
      "Which CRM is best for small revenue operations teams?",
    );
    expect(similarity).toBeGreaterThanOrEqual(0.86);
    const result = validateQuestionDraft(validDraft, {
      knownQuestions: [{ id: "existing", prompt: "Which CRM is best for small revenue operations teams?" }],
    });
    expect(result.issues.map(({ code }) => code)).toContain("duplicate");
    expect(result.nearestDuplicate).toMatchObject({ id: "existing" });
  });

  it("requires a supported type and meaningful buyer context", () => {
    const result = validateQuestionDraft({
      ...validDraft,
      questionType: "made_up_type",
      persona: "n/a",
      stage: "other",
      market: "general",
      locale: "English US",
      rationale: "test",
    });
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "invalid_type",
      "missing_persona",
      "missing_stage",
      "missing_market",
      "invalid_locale",
      "weak_rationale",
    ]));
  });

  it("normalizes accepted question and locale values", () => {
    const result = validateQuestionDraft({ ...validDraft, prompt: `  ${validDraft.prompt}  `, locale: "en_US" });
    expect(result.issues).toEqual([]);
    expect(result.value).toMatchObject({ prompt: validDraft.prompt, locale: "en-US" });
  });
});

describe("question coverage", () => {
  it("reports type, metadata and represented-context gaps from active questions only", () => {
    const coverage = summarizeQuestionCoverage([
      { id: "one", state: "active", questionType: "recommended_vendors", persona: "IT director", stage: "Discovery", market: "US", rationale: "Measures the initial vendor discovery set." },
      { id: "two", state: "active", questionType: "brand_comparison", persona: "Procurement lead", stage: "Shortlisting", market: "US", rationale: "Measures tradeoffs during shortlist review." },
      { id: "three", state: "active", questionType: "brand_comparison", persona: "IT director", stage: "Shortlisting", market: "UK", rationale: "Measures regional shortlist tradeoffs." },
      { id: "ignored", state: "archived", questionType: "alternatives", persona: "Founder", stage: "Discovery", market: "CA", rationale: "Archived questions do not define active targets." },
    ]);
    expect(coverage.activeCount).toBe(3);
    expect(coverage.missingTypes).toContain("alternatives");
    expect(coverage.personas).toEqual(["IT director", "Procurement lead"]);
    expect(coverage.markets).toEqual(["UK", "US"]);
    expect(coverage.missingCombinations).toContainEqual({ persona: "Procurement lead", stage: "Discovery", market: "UK" });
    expect(coverage.incomplete).toEqual({ persona: 0, stage: 0, market: 0, rationale: 0 });
  });
});
