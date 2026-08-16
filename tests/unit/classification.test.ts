import { describe, expect, it } from "vitest";
import { ClassificationInputError, classifyBrand, classificationKind } from "@/lib/ai";

describe("deterministic classification", () => {
  it("keeps mention, citation, recommendation, first choice, and rejection distinct", () => {
    const plain = classifyBrand({ answerText: "Acme appears in the list.", brand: { brandId: "b", name: "Acme", ownedDomains: ["acme.test"] } });
    expect(plain).toMatchObject({ mentioned: true, cited: false, explicitlyRecommended: false, firstChoice: false, rejected: false });
    const citedOnly = classifyBrand({ answerText: "A useful category guide.", citations: [{ url: "https://docs.acme.test/guide" }], brand: { brandId: "b", name: "Acme", ownedDomains: ["acme.test"] } });
    expect(citedOnly).toMatchObject({ mentioned: false, cited: true, explicitlyRecommended: false });
  });

  it("enforces first-choice implications", () => {
    const result = classifyBrand({ answerText: "1. Acme", brand: { brandId: "b", name: "Acme" } });
    expect(result).toMatchObject({ mentioned: true, explicitlyRecommended: true, firstChoice: true, rank: 1 });
    expect(classificationKind(result)).toBe("first_choice");
  });

  it("matches aliases with Unicode boundaries but not substrings", () => {
    expect(classifyBrand({ answerText: "Try RS Cloud.", brand: { brandId: "b", name: "RefineStack", aliases: ["RS Cloud"] } }).mentioned).toBe(true);
    expect(classifyBrand({ answerText: "A megacmeable token.", brand: { brandId: "b", name: "Acme" } }).mentioned).toBe(false);
  });

  it("requires commercial context for common-word brands", () => {
    const brand = { brandId: "apple", name: "Apple", requireContext: true };
    expect(classifyBrand({ answerText: "Slice the apple into a bowl.", brand }).mentioned).toBe(false);
    expect(classifyBrand({ answerText: "Apple is a software and device company.", brand }).mentioned).toBe(true);
  });

  it.each([
    ["Recomiendo Acme como la mejor opción.", true],
    ["Je recommande Acme comme meilleur choix.", true],
    ["Acme ialah pilihan terbaik dan disyorkan.", true],
    ["Acme is listed, without a recommendation.", false],
  ])("handles multilingual recommendation: %s", (answerText, expected) => {
    expect(classifyBrand({ answerText, brand: { brandId: "b", name: "Acme" } }).explicitlyRecommended).toBe(expected);
  });

  it("flags contradictory recommendation and rejection for review", () => {
    const result = classifyBrand({ answerText: "Acme is a top pick, but do not recommend Acme for regulated teams.", brand: { brandId: "b", name: "Acme" } });
    expect(result).toMatchObject({ explicitlyRecommended: true, rejected: true, requiresReview: true });
  });

  it("keeps separate positive and negative recommendation clauses contradictory", () => {
    const result = classifyBrand({ answerText: "Acme is recommended for startups. However, Acme is not recommended for banks.", brand: { brandId: "b", name: "Acme" } });
    expect(result).toMatchObject({ explicitlyRecommended: true, rejected: true, requiresReview: true });
  });

  it("does not turn a negated recommendation into a positive recommendation", () => {
    const result = classifyBrand({ answerText: "We do not recommend Acme for this workflow.", brand: { brandId: "b", name: "Acme" } });
    expect(result).toMatchObject({ mentioned: true, explicitlyRecommended: false, firstChoice: false, rejected: true });
  });

  it("does not attach another sentence's recommendation to the brand", () => {
    const result = classifyBrand({ answerText: "We recommend Beta for security. Acme is also listed.", brand: { brandId: "a", name: "Acme" } });
    expect(result).toMatchObject({ mentioned: true, explicitlyRecommended: false, firstChoice: false });
  });

  it("does not attach a comparative recommendation for another brand", () => {
    const result = classifyBrand({ answerText: "We recommend Beta over Acme for security.", brand: { brandId: "a", name: "Acme" } });
    expect(result).toMatchObject({ mentioned: true, explicitlyRecommended: false, rejected: true });
  });

  it("does not attribute clause-level decision language to every listed brand", () => {
    const answerText = "Between Acme and Beta, we recommend Beta.";
    const acme = classifyBrand({ answerText, brand: { brandId: "a", name: "Acme" } });
    const beta = classifyBrand({ answerText, brand: { brandId: "b", name: "Beta" } });
    expect(acme).toMatchObject({ mentioned: true, explicitlyRecommended: false, firstChoice: false, requiresReview: true });
    expect(beta).toMatchObject({ mentioned: true, explicitlyRecommended: true, requiresReview: false });
  });

  it("preserves exact original offsets through compatibility folding", () => {
    const answerText = "ﬃ Acme is recommended.";
    const result = classifyBrand({ answerText, brand: { brandId: "a", name: "Acme" } });
    const brandSpan = result.evidenceSpans.find(({ kind }) => kind === "brand");
    expect(brandSpan).toEqual({ start: 2, end: 6, text: "Acme", kind: "brand" });
    expect(answerText.slice(brandSpan!.start, brandSpan!.end)).toBe("Acme");
  });

  it("fails empty answers rather than inventing a high-confidence absence", () => {
    expect(() => classifyBrand({ answerText: "   ", brand: { brandId: "a", name: "Acme" } })).toThrow(ClassificationInputError);
  });

  it("distinguishes a shortlist from an explicit recommendation", () => {
    const result = classifyBrand({ answerText: "Acme was shortlisted for further review.", brand: { brandId: "a", name: "Acme" } });
    expect(result.explicitlyRecommended).toBe(false);
    expect(classificationKind(result)).toBe("shortlisted");
  });
});
