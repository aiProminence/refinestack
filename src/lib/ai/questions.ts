import { questionTypes, type QuestionType } from "@/types/contracts";

export type QuestionQuality = {
  score: number;
  issues: Array<"empty" | "too_short" | "too_long" | "leading" | "brand_loaded" | "duplicate" | "not_decision_oriented">;
  normalized: string;
};

export type QuestionDraft = {
  prompt: string;
  questionType: string;
  persona: string;
  stage: string;
  market: string;
  locale: string;
  rationale: string;
};

export type QuestionDraftIssue = {
  field: keyof QuestionDraft;
  code: string;
  message: string;
};

export type QuestionCoverageInput = Pick<QuestionDraft, "questionType" | "persona" | "stage" | "market" | "rationale"> & {
  id: string;
  state: "active" | "disqualified" | "archived";
};

export function normalizeQuestion(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function tokens(value: string): Set<string> {
  const values = normalizeQuestion(value).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(values.map((token) => {
    if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
    if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
    return token;
  }));
}

export function questionSimilarity(a: string, b: string): number {
  const left = tokens(a); const right = tokens(b);
  if (!left.size && !right.size) return 1;
  const intersection = [...left].filter((item) => right.has(item)).length;
  const union = new Set([...left, ...right]).size;
  const sizeRatio = Math.min(left.size, right.size) / Math.max(left.size, right.size);
  const containment = intersection / Math.min(left.size, right.size);
  return Math.max(intersection / union, sizeRatio >= 0.75 ? containment : 0);
}

export function evaluateQuestionQuality(question: string, options: { knownQuestions?: string[]; trackedBrands?: string[] } = {}): QuestionQuality {
  const normalized = normalizeQuestion(question);
  const issues: QuestionQuality["issues"] = [];
  if (!normalized) issues.push("empty");
  if (normalized.length > 0 && normalized.length < 18) issues.push("too_short");
  if (normalized.length > 500) issues.push("too_long");
  if (/\b(?:obviously|clearly|isn't it true|wouldn't you agree)\b/iu.test(normalized)) issues.push("leading");
  if ((options.trackedBrands ?? []).some((brand) => brand.trim() && normalizeQuestion(normalized).toLocaleLowerCase().includes(normalizeQuestion(brand).toLocaleLowerCase()))) issues.push("brand_loaded");
  if ((options.knownQuestions ?? []).some((known) => questionSimilarity(normalized, known) >= 0.86)) issues.push("duplicate");
  if (!/[?？]$/.test(normalized) && !/^(?:what|which|who|how|why|when|where|recommend|compare|find|suggest|can|should|is|are|do|does)\b/iu.test(normalized)) issues.push("not_decision_oriented");
  const penalties: Record<QuestionQuality["issues"][number], number> = { empty: 100, too_short: 25, too_long: 20, leading: 25, brand_loaded: 20, duplicate: 40, not_decision_oriented: 15 };
  return { score: Math.max(0, 100 - issues.reduce((sum, issue) => sum + penalties[issue], 0)), issues, normalized };
}

export function findDuplicateQuestionGroups(questions: Array<{ id: string; text: string }>, threshold = 0.86): string[][] {
  const parent = new Map(questions.map(({ id }) => [id, id]));
  const root = (id: string): string => parent.get(id) === id ? id : root(parent.get(id)!);
  for (let i = 0; i < questions.length; i++) for (let j = i + 1; j < questions.length; j++) {
    if (questionSimilarity(questions[i].text, questions[j].text) >= threshold) parent.set(root(questions[j].id), root(questions[i].id));
  }
  const groups = new Map<string, string[]>();
  questions.forEach(({ id }) => groups.set(root(id), [...(groups.get(root(id)) ?? []), id]));
  return [...groups.values()].filter((group) => group.length > 1);
}

const placeholder = /^(?:n\/?a|none|unknown|tbd|test|general|other|-+)$/iu;

function meaningful(value: string, minimumLength = 2): boolean {
  const normalized = normalizeQuestion(value);
  return normalized.length >= minimumLength && !placeholder.test(normalized) && /[\p{L}\p{N}]/u.test(normalized);
}

const qualityMessages: Record<QuestionQuality["issues"][number], string> = {
  empty: "Enter the exact buyer question.",
  too_short: "Use at least 18 characters so the buyer decision is unambiguous.",
  too_long: "Keep the question to 500 characters or fewer.",
  leading: "Remove leading language such as ‘obviously’ or ‘wouldn’t you agree’.",
  brand_loaded: "Remove tracked-brand language that biases the answer.",
  duplicate: "This question is an exact or near duplicate of an existing project question.",
  not_decision_oriented: "Phrase this as a buyer decision question, such as ‘Which…?’, ‘How…?’ or ‘Compare…’. ",
};

export function validateQuestionDraft(
  input: QuestionDraft,
  options: { knownQuestions?: Array<{ id: string; prompt: string }>; trackedBrands?: string[] } = {},
) {
  const knownQuestions = options.knownQuestions ?? [];
  const quality = evaluateQuestionQuality(input.prompt, {
    knownQuestions: knownQuestions.map(({ prompt }) => prompt),
    trackedBrands: options.trackedBrands,
  });
  const issues: QuestionDraftIssue[] = quality.issues.map((code) => ({
    field: "prompt",
    code,
    message: qualityMessages[code].trim(),
  }));
  if (!questionTypes.includes(input.questionType as QuestionType)) {
    issues.push({ field: "questionType", code: "invalid_type", message: "Choose a supported question type." });
  }
  if (!meaningful(input.market)) issues.push({ field: "market", code: "missing_market", message: "Name the buyer market; placeholders such as ‘general’ are not accepted." });
  if (!meaningful(input.locale) || !/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/iu.test(input.locale.trim())) {
    issues.push({ field: "locale", code: "invalid_locale", message: "Use a locale code such as en-US, en-GB or ms-MY." });
  }
  if (!meaningful(input.persona)) issues.push({ field: "persona", code: "missing_persona", message: "Name the buyer persona; placeholders are not accepted." });
  if (!meaningful(input.stage)) issues.push({ field: "stage", code: "missing_stage", message: "Name the journey stage; placeholders are not accepted." });
  if (!meaningful(input.rationale, 12) || tokens(input.rationale).size < 3) {
    issues.push({ field: "rationale", code: "weak_rationale", message: "Explain in at least three words what buyer decision this question measures." });
  }
  const nearestDuplicate = knownQuestions
    .map((question) => ({ ...question, similarity: questionSimilarity(quality.normalized, question.prompt) }))
    .sort((a, b) => b.similarity - a.similarity)[0] ?? null;
  return {
    quality,
    issues,
    nearestDuplicate: nearestDuplicate && nearestDuplicate.similarity >= 0.86 ? nearestDuplicate : null,
    value: {
      prompt: quality.normalized,
      questionType: input.questionType.trim(),
      persona: normalizeQuestion(input.persona),
      stage: normalizeQuestion(input.stage),
      market: normalizeQuestion(input.market),
      locale: input.locale.trim().replaceAll("_", "-"),
      rationale: normalizeQuestion(input.rationale),
    },
  };
}

export function summarizeQuestionCoverage(questions: QuestionCoverageInput[]) {
  const active = questions.filter(({ state }) => state === "active");
  const distinct = (field: "persona" | "stage" | "market") => [...new Set(active.map((question) => normalizeQuestion(question[field])).filter(Boolean))].toSorted((a, b) => a.localeCompare(b));
  const personas = distinct("persona");
  const stages = distinct("stage");
  const markets = distinct("market");
  const rows = questionTypes.map((questionType) => {
    const matching = active.filter((question) => question.questionType === questionType);
    return {
      questionType,
      total: matching.length,
      personas: [...new Set(matching.map(({ persona }) => normalizeQuestion(persona)).filter(Boolean))].toSorted(),
      stages: [...new Set(matching.map(({ stage }) => normalizeQuestion(stage)).filter(Boolean))].toSorted(),
      markets: [...new Set(matching.map(({ market }) => normalizeQuestion(market)).filter(Boolean))].toSorted(),
    };
  });
  const combinations = personas.flatMap((persona) => stages.flatMap((stage) => markets.map((market) => ({ persona, stage, market }))));
  const missingCombinations = combinations.filter((combination) => !active.some((question) =>
    normalizeQuestion(question.persona) === combination.persona
      && normalizeQuestion(question.stage) === combination.stage
      && normalizeQuestion(question.market) === combination.market));
  return {
    activeCount: active.length,
    personas,
    stages,
    markets,
    rows,
    missingTypes: rows.filter(({ total }) => total === 0).map(({ questionType }) => questionType),
    missingCombinations,
    incomplete: {
      persona: active.filter(({ persona }) => !meaningful(persona)).length,
      stage: active.filter(({ stage }) => !meaningful(stage)).length,
      market: active.filter(({ market }) => !meaningful(market)).length,
      rationale: active.filter(({ rationale }) => !meaningful(rationale, 12) || tokens(rationale).size < 3).length,
    },
  };
}
