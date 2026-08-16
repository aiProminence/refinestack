import type { CitationInput, ClassificationResult } from "@/types/contracts";

export type BrandDefinition = {
  brandId: string;
  name: string;
  aliases?: string[];
  ownedDomains?: string[];
  requireContext?: boolean;
  contextTerms?: string[];
};

export type ClassificationInput = {
  answerText: string;
  citations?: CitationInput[];
  brand: BrandDefinition;
  reviewThreshold?: number;
};

const RECOMMEND = [
  /\b(?:recommend(?:ed)?|top pick|best (?:choice|option)|strong choice|should choose)\b/iu,
  /\b(?:recomiendo|recomendad[oa]|mejor opci[oó]n|deber[ií]as elegir)\b/iu,
  /\b(?:je recommande|meilleur choix|devriez choisir)\b/iu,
  /\b(?:disyorkan|pilihan terbaik|patut pilih)\b/iu,
];
const SHORTLIST = [
  /\b(?:shortlist(?:ed)?|consider(?:ed)?|candidate|one of the options)\b/iu,
  /\b(?:preseleccionad[oa]|candidat[oa]|considere)\b/iu,
  /\b(?:présélectionné|candidat|envisager)\b/iu,
  /\b(?:disenarai pendek|calon|pertimbangkan)\b/iu,
];
const FIRST = [
  /\b(?:first choice|first pick|top choice|best overall|#1|number one)\b/iu,
  /\b(?:primera opci[oó]n|mejor en general|n[uú]mero uno)\b/iu,
  /\b(?:premier choix|meilleur dans l'ensemble|num[eé]ro un)\b/iu,
  /\b(?:pilihan pertama|terbaik keseluruhan|nombor satu)\b/iu,
];
const REJECT = [
  /\b(?:do not recommend|not recommended|avoid|poor (?:choice|fit)|should not choose|reject(?:ed)?)\b/iu,
  /\b(?:no recomiendo|evita|mala opci[oó]n)\b/iu,
  /\b(?:ne recommande pas|[àa] [ée]viter|mauvais choix)\b/iu,
  /\b(?:tidak disyorkan|elakkan|pilihan yang lemah)\b/iu,
];
const COMMERCIAL_CONTEXT = /\b(?:platform|product|service|software|vendor|company|tool|app|pricing|integrat(?:e|ion)|buy|choose|solution|brand|website)\b/iu;
const CLAUSE_BOUNDARY = /[.!?;\n]|,\s*(?:but|however|while|whereas|although)\b/giu;
const CONTEXT_SENSITIVE_NAMES = new Set(["apple", "box", "buffer", "drift", "intercom", "linear", "meta", "monday", "notion", "oracle", "orange", "stripe", "target", "x"]);

type Occurrence = { start: number; end: number; value: string };
type EvidenceSpan = ClassificationResult["evidenceSpans"][number];

function foldedWithOffsets(value: string) {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < value.length;) {
    const point = value.codePointAt(offset)!;
    const original = String.fromCodePoint(point);
    const next = offset + original.length;
    const folded = original.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    for (const character of folded) {
      text += character;
      for (let index = 0; index < character.length; index += 1) { starts.push(offset); ends.push(next); }
    }
    offset = next;
  }
  return { text, starts, ends };
}

function fold(value: string) { return foldedWithOffsets(value).text; }
function escape(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function mentions(text: string, aliases: string[]): Occurrence[] {
  const normalized = foldedWithOffsets(text);
  const found: Occurrence[] = [];
  for (const alias of aliases) {
    const expression = escape(fold(alias)).replace(/[\s_-]+/g, "[\\s_-]+");
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${expression})(?=$|[^\\p{L}\\p{N}])`, "giu");
    for (const match of normalized.text.matchAll(pattern)) {
      const foldedStart = (match.index ?? 0) + (match[1]?.length ?? 0);
      const foldedEnd = foldedStart + match[2].length;
      const start = normalized.starts[foldedStart];
      const end = normalized.ends[foldedEnd - 1];
      if (start !== undefined && end !== undefined) found.push({ start, end, value: text.slice(start, end) });
    }
  }
  return found.sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((item, index, all) => !all.slice(0, index).some((prior) => prior.start === item.start && prior.end >= item.end));
}

function hostnameMatches(url: string, domains: string[]) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return domains.some((domain) => {
      let candidate = domain.trim().toLowerCase();
      try { candidate = new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname; } catch { return false; }
      candidate = candidate.replace(/^www\./, "");
      return Boolean(candidate) && (host === candidate || host.endsWith(`.${candidate}`));
    });
  } catch { return false; }
}

function clause(text: string, occurrence: Occurrence) {
  const boundaries = [...text.matchAll(CLAUSE_BOUNDARY)].map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
  const prior = boundaries.filter(({ end }) => end <= occurrence.start).at(-1);
  const next = boundaries.find(({ start }) => start >= occurrence.end);
  const start = prior?.end ?? 0;
  const end = next?.start ?? text.length;
  return { start, end, text: text.slice(start, end) };
}

function signalTargetsOccurrence(sectionText: string, sectionStart: number, occurrence: Occurrence, signalStart: number, signalEnd: number) {
  const occurrenceStart = occurrence.start - sectionStart;
  const occurrenceEnd = occurrence.end - sectionStart;
  if (signalEnd <= occurrenceStart) {
    const gap = sectionText.slice(signalEnd, occurrenceStart);
    return /^[\s:–—("']*(?:(?:the|this|that|our|my|your|their|a|an)\s+)?$/iu.test(gap);
  }
  if (occurrenceEnd <= signalStart) {
    const gap = sectionText.slice(occurrenceEnd, signalStart);
    return /^[\s,:–—("']*(?:(?:is|was|remains|became|would\s+be|as|a|an|the|est|es|fue|sería|ialah|adalah|comme|un|une|le|la|les)\s+)*$/iu.test(gap);
  }
  return true;
}

function patternEvidence(text: string, occurrence: Occurrence, patterns: RegExp[], kind: EvidenceSpan["kind"]): EvidenceSpan | undefined {
  const section = clause(text, occurrence);
  for (const pattern of patterns) {
    const match = pattern.exec(section.text);
    if (match?.[0]) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (signalTargetsOccurrence(section.text, section.start, occurrence, start, end)) {
        return { start: section.start + start, end: section.start + end, text: match[0], kind };
      }
    }
  }
  return undefined;
}

function hasSignalInBrandClause(text: string, occurrences: Occurrence[], patterns: RegExp[]) {
  return occurrences.some((occurrence) => patterns.some((pattern) => pattern.test(clause(text, occurrence).text)));
}

export function brandNeedsContext(name: string, aliases: string[] = []) {
  return [name, ...aliases].some((value) => {
    const normalized = fold(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return normalized.length <= 3 || CONTEXT_SENSITIVE_NAMES.has(normalized);
  });
}

function comparativeRejection(text: string, occurrence: Occurrence): EvidenceSpan | undefined {
  const section = clause(text, occurrence);
  const beforeBrand = section.text.slice(0, occurrence.start - section.start);
  const match = beforeBrand.match(/\b(?:instead of|rather than|over|not)\s*$/iu);
  if (!match?.[0]) return undefined;
  const start = section.start + beforeBrand.length - match[0].length;
  return { start, end: start + match[0].length, text: match[0], kind: "rejection" };
}

function listRank(text: string, occurrence: Occurrence) {
  const lineStart = text.lastIndexOf("\n", occurrence.start - 1) + 1;
  const lineEndIndex = text.indexOf("\n", occurrence.end);
  const line = text.slice(lineStart, lineEndIndex < 0 ? text.length : lineEndIndex);
  const match = line.match(/^\s*(?:#?\s*)?(\d{1,2})[.)\-:]\s+/u);
  return match && lineStart + match[0].length === occurrence.start ? Number(match[1]) : null;
}

export class ClassificationInputError extends Error { readonly name = "ClassificationInputError"; }

export function classifyBrand(input: ClassificationInput): ClassificationResult {
  if (!input.answerText.trim()) throw new ClassificationInputError("Cannot classify an empty answer.");
  if (input.answerText.length > 1_000_000) throw new ClassificationInputError("Answer exceeds the classification size limit.");
  if (!input.brand.brandId.trim() || !input.brand.name.trim()) throw new ClassificationInputError("Brand identity is required.");
  if ((input.brand.aliases?.length ?? 0) > 100) throw new ClassificationInputError("Brand alias limit exceeded.");
  const threshold = input.reviewThreshold ?? 0.85;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new ClassificationInputError("Review threshold must be between zero and one.");

  const aliases = [...new Set([input.brand.name, ...(input.brand.aliases ?? [])].map((value) => value.trim()).filter(Boolean))];
  let occurrences = mentions(input.answerText, aliases);
  const cited = (input.citations ?? []).some((citation) => hostnameMatches(citation.url, input.brand.ownedDomains ?? []));
  if (input.brand.requireContext && occurrences.length) {
    occurrences = occurrences.filter((occurrence) => {
      const local = clause(input.answerText, occurrence).text;
      const custom = (input.brand.contextTerms ?? []).some((term) => term.trim() && fold(local).includes(fold(term)));
      return custom || COMMERCIAL_CONTEXT.test(local);
    });
  }
  const mentioned = occurrences.length > 0;
  const recommendationSpans = occurrences.flatMap((item) => patternEvidence(input.answerText, item, RECOMMEND, "recommendation") ?? []);
  const shortlistSpans = occurrences.flatMap((item) => patternEvidence(input.answerText, item, SHORTLIST, "recommendation") ?? []);
  const rejectionSpans = occurrences.flatMap((item) => [patternEvidence(input.answerText, item, REJECT, "rejection"), comparativeRejection(input.answerText, item)].filter((span): span is EvidenceSpan => Boolean(span)));
  const firstSpans = occurrences.flatMap((item) => patternEvidence(input.answerText, item, FIRST, "first_choice") ?? []);
  const unboundDecisionSignal = mentioned && (
    (recommendationSpans.length === 0 && hasSignalInBrandClause(input.answerText, occurrences, RECOMMEND))
    || (firstSpans.length === 0 && hasSignalInBrandClause(input.answerText, occurrences, FIRST))
  );
  let rank = occurrences.map((item) => listRank(input.answerText, item)).find((value) => value !== null) ?? null;
  const positiveRecommendationSpans = recommendationSpans.filter((recommendation) => !rejectionSpans.some((rejection) =>
    (rejection.start <= recommendation.start && rejection.end >= recommendation.end)
    || (rejection.start > recommendation.end && rejection.start - recommendation.end < 80 && /\b(?:instead of|rather than|over)\b/iu.test(rejection.text)),
  ));
  let explicitlyRecommended = mentioned && positiveRecommendationSpans.length > 0;
  let firstChoice = mentioned && (firstSpans.length > 0 || rank === 1);
  if (firstChoice) explicitlyRecommended = true;
  const rejected = mentioned && rejectionSpans.length > 0;
  if (!mentioned) { explicitlyRecommended = false; firstChoice = false; rank = null; }
  const evidenceSpans: EvidenceSpan[] = [
    ...occurrences.map(({ start, end, value }) => ({ start, end, text: value, kind: "brand" as const })),
    ...positiveRecommendationSpans, ...shortlistSpans, ...firstSpans, ...rejectionSpans,
  ].sort((a, b) => a.start - b.start || a.end - b.end).filter((item, index, all) => !all.slice(0, index).some((prior) => prior.start === item.start && prior.end === item.end && prior.kind === item.kind)).slice(0, 24);
  const ambiguous = explicitlyRecommended && rejected;
  const confidence = mentioned || cited ? (ambiguous ? 0.55 : unboundDecisionSignal ? 0.6 : input.brand.requireContext ? 0.82 : 0.95) : 0.98;
  const shortlist = mentioned && (shortlistSpans.length > 0 || (rank !== null && rank > 1));
  return {
    brandId: input.brand.brandId, mentioned, cited, explicitlyRecommended, firstChoice, rejected, confidence, rank, evidenceSpans,
    rationale: [mentioned ? "brand alias found" : "no contextual brand alias found", cited ? "owned-domain citation found" : "no owned-domain citation", shortlist ? "shortlist evidence found" : "no shortlist evidence", explicitlyRecommended ? "recommendation language found" : "no recommendation language", firstChoice ? "first-choice evidence found" : "no first-choice evidence", rejected ? "rejection language found" : "no rejection language", unboundDecisionSignal ? "unbound decision language requires review" : "decision language bound to brand"].join("; "),
    classifierName: "refinestack-deterministic", classifierVersion: "2.1.0", requiresReview: ambiguous || unboundDecisionSignal || confidence < threshold,
  };
}

export const classifyObservation = classifyBrand;

export function classificationKind(result: ClassificationResult): "absent" | "mentioned" | "shortlisted" | "recommended" | "first_choice" | "rejected" {
  if (result.rejected) return "rejected";
  if (result.firstChoice) return "first_choice";
  if (result.explicitlyRecommended) return "recommended";
  if (result.mentioned && ((result.rank !== null && result.rank > 1) || result.rationale.includes("shortlist evidence found"))) return "shortlisted";
  if (result.mentioned) return "mentioned";
  return "absent";
}
