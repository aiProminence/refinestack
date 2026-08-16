export type EvidenceFinding = {
  id: string;
  questionId: string;
  kind: "missing_mention" | "lost_recommendation" | "citation_gap" | "rejection";
  observation: string;
  answerExcerpt?: string;
  citationUrls?: string[];
  provider: string;
};
export type DraftAction = {
  title: string;
  rationale: string;
  steps: string[];
  evidenceFindingIds: string[];
  affectedQuestionIds: string[];
  expectedImpact: "low" | "medium" | "high";
  effort: "low" | "medium" | "high";
  uncertainty: "low" | "medium" | "high";
};

export function draftEvidenceBackedAction(findings: EvidenceFinding[]): DraftAction | null {
  const usable = findings.filter((finding) => finding.id && finding.questionId && finding.observation.trim() && finding.provider.trim() && (finding.answerExcerpt?.trim() || finding.citationUrls?.length));
  if (!usable.length) return null;
  const kinds = new Set(usable.map(({ kind }) => kind));
  const questionIds = [...new Set(usable.map(({ questionId }) => questionId))];
  const dominant = [...kinds][0];
  const templates: Record<EvidenceFinding["kind"], Pick<DraftAction, "title" | "steps">> = {
    missing_mention: { title: "Clarify category relevance on evidence-rich pages", steps: ["Map the affected questions to an authoritative owned page.", "Add concise category and use-case language supported by verifiable facts.", "Re-run the same questions and compare only compatible cohorts."] },
    lost_recommendation: { title: "Strengthen decision-stage differentiation", steps: ["Review the observed recommendation criteria in the cited answers.", "Publish verifiable proof for the criteria where the product genuinely qualifies.", "Re-run the affected questions without changing the cohort."] },
    citation_gap: { title: "Improve authoritative answer-source coverage", steps: ["Audit cited third-party sources and the missing owned evidence.", "Create or update a crawlable page with primary, dated evidence.", "Validate discovery and re-run the affected questions."] },
    rejection: { title: "Address evidenced buyer objections", steps: ["Group the cited rejection statements by concrete objection.", "Correct product or documentation gaps that can be substantiated.", "Re-run the affected questions and review contradictory outcomes manually."] },
  };
  const template = templates[dominant];
  return {
    title: template.title,
    rationale: `Based on ${usable.length} captured observation${usable.length === 1 ? "" : "s"} across ${questionIds.length} question${questionIds.length === 1 ? "" : "s"}; this is a hypothesis, not a causal claim.`,
    steps: template.steps, evidenceFindingIds: usable.map(({ id }) => id), affectedQuestionIds: questionIds,
    expectedImpact: usable.length >= 5 ? "high" : usable.length >= 2 ? "medium" : "low",
    effort: kinds.size > 1 ? "high" : "medium", uncertainty: kinds.size > 1 || usable.some(({ answerExcerpt }) => !answerExcerpt) ? "high" : "medium",
  };
}

