import { describe, expect, it } from "vitest";
import { calculateMetrics, captureCoverage, comparisonCompatibility, evidenceSupportRate, filterMetricRecords, firstChoiceRate, mentionRate, mentionShare, ownedCitationRate, recommendationRate, recommendationShare, type CaptureFact } from "@/lib/metrics";

const rows: CaptureFact[] = [
  { id: "ok-1", status: "succeeded", classificationState: "auto_accepted", classifierVersion: "2", mentioned: true, explicitlyRecommended: true, firstChoice: true, hasOwnedCitation: true, hasEvidence: true, brandOccurrences: 2, trackedBrandOccurrences: 4, recommendationSlots: 1, trackedRecommendationSlots: 3 },
  { id: "ok-2", status: "succeeded", classificationState: "auto_accepted", classifierVersion: "2", mentioned: false, explicitlyRecommended: false, firstChoice: false, hasOwnedCitation: false, hasEvidence: true, brandOccurrences: 0, trackedBrandOccurrences: 1, recommendationSlots: 0, trackedRecommendationSlots: 2 },
  { id: "failed", status: "failed", mentioned: true, explicitlyRecommended: true, firstChoice: true },
  { id: "unavailable", status: "unavailable" },
];

describe("metrics", () => {
  it("keeps failed and unavailable captures visible but outside answer denominators", () => {
    expect(captureCoverage(rows)).toMatchObject({ numerator: 2, denominator: 4, value: 0.5, includedIds: ["ok-1", "ok-2"], excludedIds: ["failed", "unavailable"] });
    expect(mentionRate(rows)).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, excludedIds: ["failed", "unavailable"] });
    expect(recommendationRate(rows).value).toBe(0.5);
    expect(firstChoiceRate(rows).value).toBe(0.5);
    expect(ownedCitationRate(rows).value).toBe(0.5);
    expect(evidenceSupportRate(rows).value).toBe(1);
  });

  it("calculates shares from occurrences and slots, not capture counts", () => {
    expect(mentionShare(rows)).toMatchObject({ numerator: 2, denominator: 5, value: 0.4 });
    expect(recommendationShare(rows)).toMatchObject({ numerator: 1, denominator: 5, value: 0.2 });
  });

  it("uses eligibility and claim counts for their exact denominators", () => {
    expect(recommendationRate([{ id: "eligible", status: "succeeded", classificationState: "approved", recommendationEligible: true, explicitlyRecommended: true }, { id: "ineligible", status: "succeeded", classificationState: "approved", recommendationEligible: false, explicitlyRecommended: false }])).toMatchObject({ numerator: 1, denominator: 1, includedIds: ["eligible"], excludedIds: ["ineligible"] });
    expect(evidenceSupportRate([{ id: "claims", status: "succeeded", classificationState: "approved", supportedClaimCount: 2, totalClassifiedClaimCount: 5 }, { id: "none", status: "succeeded", classificationState: "approved" }])).toMatchObject({ numerator: 2, denominator: 5, value: 0.4, includedIds: ["claims"], excludedIds: ["none"] });
  });

  it("returns null rather than NaN for zero denominators", () => {
    expect(mentionRate([])).toMatchObject({ numerator: 0, denominator: 0, value: null });
    expect(mentionShare([{ id: "x", status: "succeeded" }])).toMatchObject({ denominator: 0, value: null });
    expect(Number.isNaN(mentionRate([]).value as number)).toBe(false);
  });

  it("rejects duplicate capture IDs instead of using input order", () => {
    expect(() => captureCoverage([rows[0], rows[0]])).toThrow(/Duplicate capture metric identity/);
  });

  it("excludes unclassified and pending-review captures from classification metrics", () => {
    expect(mentionRate([{ id: "unclassified", status: "succeeded" }, { id: "pending", status: "succeeded", classificationState: "pending_review", mentioned: true }])).toMatchObject({ numerator: 0, denominator: 0, value: null, excludedIds: ["unclassified", "pending"] });
  });

  it("rejects impossible fractions before publishing a metric", () => {
    expect(() => evidenceSupportRate([{ id: "bad", status: "succeeded", classificationState: "approved", supportedClaimCount: 5, totalClassifiedClaimCount: 2 }])).toThrow(/cannot exceed/);
  });

  it("returns the complete worker-facing metric set", () => {
    expect(Object.keys(calculateMetrics(rows))).toEqual(["capture_coverage", "mention_rate", "mention_share", "recommendation_rate", "recommendation_share", "first_choice_rate", "owned_citation_rate", "evidence_support_rate"]);
  });

  it("warns for every incompatible comparison dimension", () => {
    const warnings = comparisonCompatibility(
      { coverage: 1, questionIds: ["q1"], providers: ["openai"], models: ["m1"], markets: ["us"], classifierVersion: "1", trackedBrandIds: ["b1"] },
      { coverage: 0.5, questionIds: ["q2"], providers: ["claude"], models: ["m2"], markets: ["gb"], classifierVersion: "2", trackedBrandIds: ["b2"] },
    );
    expect(warnings.map(({ code }) => code)).toEqual(["coverage_change", "question_set_change", "provider_set_change", "model_change", "market_change", "classifier_change", "tracked_brand_change"]);
    expect(warnings.filter(({ severity }) => severity === "blocking")).toHaveLength(4);
  });

  it("applies cohort filters consistently and fingerprints the result", () => {
    const facts: CaptureFact[] = [
      { id: "us", status: "succeeded", classificationState: "approved", provider: "openai", market: "us", locale: "en-US", questionId: "q1", questionType: "recommended_vendors", persona: "CIO", competitorIds: ["beta"], classifierVersion: "2", mentioned: true, capturedAt: "2026-01-01T00:00:00.000Z" },
      { id: "gb", status: "succeeded", classificationState: "approved", provider: "claude", market: "gb", locale: "en-GB", questionId: "q2", questionType: "category_discovery", persona: "Founder", competitorIds: ["gamma"], classifierVersion: "2", mentioned: false, capturedAt: "2026-02-01T00:00:00.000Z" },
    ];
    expect(filterMetricRecords(facts, { providers: ["openai"], markets: ["us"], from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T23:59:59.000Z" }).map(({ id }) => id)).toEqual(["us"]);
    expect(filterMetricRecords(facts, { questionTypes: ["recommended_vendors"], personas: ["CIO"], competitorIds: ["beta"] }).map(({ id }) => id)).toEqual(["us"]);
    const metric = calculateMetrics(facts, { providers: ["openai"] }).mention_rate;
    expect(metric).toMatchObject({ numerator: 1, denominator: 1, cohort: { captureIds: ["us"], providers: ["openai"] } });
    expect(metric.cohortKey).toMatch(/^cohort_[a-f0-9]{8}$/);
  });
});
