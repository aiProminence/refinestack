import type { MetricValue, ProviderKey } from "@/types/contracts";

export type ClassificationState = "auto_accepted" | "approved" | "pending_review" | "unclassified" | "rejected";
export type CaptureFact = {
  id: string;
  status: "succeeded" | "failed" | "unavailable" | "cancelled" | "queued" | "running";
  classificationState?: ClassificationState;
  classifierVersion?: string;
  provider?: ProviderKey;
  model?: string;
  locale?: string;
  market?: string;
  questionId?: string;
  questionVersion?: string;
  questionType?: string;
  persona?: string;
  competitorIds?: string[];
  trackedBrandIds?: string[];
  capturedAt?: string;
  mentioned?: boolean;
  explicitlyRecommended?: boolean;
  recommendationEligible?: boolean;
  firstChoice?: boolean;
  hasOwnedCitation?: boolean;
  hasEvidence?: boolean;
  supportedClaimCount?: number;
  totalClassifiedClaimCount?: number;
  brandOccurrences?: number;
  trackedBrandOccurrences?: number;
  recommendationSlots?: number;
  trackedRecommendationSlots?: number;
};

export type MetricCohort = {
  captureIds: string[];
  providers: ProviderKey[];
  models: string[];
  locales: string[];
  markets: string[];
  questionIds: string[];
  questionVersions: string[];
  questionTypes: string[];
  personas: string[];
  competitorIds: string[];
  classifierVersions: string[];
  trackedBrandIds: string[];
  from?: string;
  to?: string;
};
export type MetricFilter = Partial<Omit<MetricCohort, "captureIds" | "from" | "to">> & { from?: string; to?: string };
export type MetricExclusion = { id: string; reason: "capture_not_succeeded" | "classification_not_eligible" | "recommendation_not_eligible" | "no_classified_claims" };
export type MetricResult = MetricValue & {
  includedIds: string[];
  excludedIds: string[];
  exclusions: MetricExclusion[];
  formula: string;
  cohort: MetricCohort;
  cohortKey: string;
};

const VERSION = "2.0.0";
const FORMULAS: Record<MetricValue["key"], string> = {
  capture_coverage: "succeeded scheduled captures / all scheduled captures",
  mention_rate: "eligible succeeded captures mentioning focal brand / eligible succeeded captures",
  mention_share: "focal-brand occurrences / all tracked-brand occurrences",
  recommendation_rate: "eligible captures explicitly recommending focal brand / eligible captures",
  recommendation_share: "focal-brand recommendation slots / tracked-brand recommendation slots",
  first_choice_rate: "eligible captures ranking focal brand first / eligible captures",
  owned_citation_rate: "succeeded captures citing owned domain / succeeded captures",
  evidence_support_rate: "classified claims with retrievable source / classified claims",
};
const NUMERIC_FIELDS = ["supportedClaimCount", "totalClassifiedClaimCount", "brandOccurrences", "trackedBrandOccurrences", "recommendationSlots", "trackedRecommendationSlots"] as const;

function validate(records: CaptureFact[]) {
  const seen = new Set<string>();
  for (const record of records) {
    if (!record.id.trim()) throw new TypeError("Capture metric identity is required.");
    if (seen.has(record.id)) throw new TypeError(`Duplicate capture metric identity: ${record.id}`);
    seen.add(record.id);
    for (const field of NUMERIC_FIELDS) {
      const value = record[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError(`${field} must be a nonnegative safe integer.`);
    }
    if ((record.supportedClaimCount ?? 0) > (record.totalClassifiedClaimCount ?? Number.MAX_SAFE_INTEGER)) throw new RangeError("Supported claim count cannot exceed total classified claims.");
    if ((record.brandOccurrences ?? 0) > (record.trackedBrandOccurrences ?? Number.MAX_SAFE_INTEGER)) throw new RangeError("Brand occurrences cannot exceed tracked-brand occurrences.");
    if ((record.recommendationSlots ?? 0) > (record.trackedRecommendationSlots ?? Number.MAX_SAFE_INTEGER)) throw new RangeError("Recommendation slots cannot exceed tracked-brand recommendation slots.");
  }
  return records;
}

const values = <K extends keyof CaptureFact>(records: CaptureFact[], key: K) => [...new Set(records.flatMap((record) => {
  const value = record[key];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}) as Array<string | ProviderKey>)].map(String).sort();

function cohort(records: CaptureFact[]): MetricCohort {
  const dates = records.map(({ capturedAt }) => capturedAt).filter((value): value is string => Boolean(value)).sort();
  return {
    captureIds: records.map(({ id }) => id).sort(), providers: values(records, "provider") as ProviderKey[], models: values(records, "model"),
    locales: values(records, "locale"), markets: values(records, "market"), questionIds: values(records, "questionId"),
    questionVersions: values(records, "questionVersion"), questionTypes: values(records, "questionType"), personas: values(records, "persona"), competitorIds: values(records, "competitorIds"),
    classifierVersions: values(records, "classifierVersion"), trackedBrandIds: values(records, "trackedBrandIds"),
    from: dates[0], to: dates.at(-1),
  };
}

function stableKey(value: unknown) {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) { hash ^= json.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return `cohort_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function result(key: MetricValue["key"], numerator: number, denominator: number, includedIds: string[], exclusions: MetricExclusion[], records: CaptureFact[]): MetricResult {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || denominator < 0 || numerator > denominator) throw new RangeError(`Invalid ${key} fraction ${numerator}/${denominator}.`);
  const metricCohort = cohort(records);
  return { key, numerator, denominator, value: denominator === 0 ? null : numerator / denominator, metricVersion: VERSION, includedIds, excludedIds: exclusions.map(({ id }) => id), exclusions, formula: FORMULAS[key], cohort: metricCohort, cohortKey: stableKey(metricCohort) };
}

function eligibleClassification(record: CaptureFact) { return record.classificationState === "auto_accepted" || record.classificationState === "approved"; }
function partition(records: CaptureFact[], classificationRequired: boolean) {
  validate(records);
  const included = records.filter((record) => record.status === "succeeded" && (!classificationRequired || eligibleClassification(record)));
  const exclusions: MetricExclusion[] = records.filter((record) => !included.includes(record)).map((record) => ({ id: record.id, reason: record.status !== "succeeded" ? "capture_not_succeeded" : "classification_not_eligible" }));
  return { included, exclusions };
}

export function filterMetricRecords(records: CaptureFact[], filter: MetricFilter = {}) {
  validate(records);
  const arrayFields = ["providers", "models", "locales", "markets", "questionIds", "questionVersions", "questionTypes", "personas", "competitorIds", "classifierVersions", "trackedBrandIds"] as const;
  const mapping: Record<typeof arrayFields[number], keyof CaptureFact> = { providers: "provider", models: "model", locales: "locale", markets: "market", questionIds: "questionId", questionVersions: "questionVersion", questionTypes: "questionType", personas: "persona", competitorIds: "competitorIds", classifierVersions: "classifierVersion", trackedBrandIds: "trackedBrandIds" };
  return records.filter((record) => {
    for (const field of arrayFields) {
      const selected = filter[field];
      if (!selected?.length) continue;
      const candidate = record[mapping[field]];
      const candidates = Array.isArray(candidate) ? candidate : candidate === undefined ? [] : [candidate];
      if (!candidates.some((value) => selected.includes(value as never))) return false;
    }
    if (filter.from && (!record.capturedAt || record.capturedAt < filter.from)) return false;
    if (filter.to && (!record.capturedAt || record.capturedAt > filter.to)) return false;
    return true;
  });
}

export function captureCoverage(records: CaptureFact[]): MetricResult {
  validate(records); const included = records.filter(({ status }) => status === "succeeded");
  const exclusions = records.filter(({ status }) => status !== "succeeded").map(({ id }): MetricExclusion => ({ id, reason: "capture_not_succeeded" }));
  return result("capture_coverage", included.length, records.length, included.map(({ id }) => id), exclusions, records);
}
export function mentionRate(records: CaptureFact[]): MetricResult {
  const { included, exclusions } = partition(records, true);
  return result("mention_rate", included.filter(({ mentioned }) => mentioned).length, included.length, included.map(({ id }) => id), exclusions, records);
}
export function mentionShare(records: CaptureFact[]): MetricResult {
  const { included, exclusions } = partition(records, true);
  return result("mention_share", included.reduce((sum, row) => sum + (row.brandOccurrences ?? 0), 0), included.reduce((sum, row) => sum + (row.trackedBrandOccurrences ?? 0), 0), included.map(({ id }) => id), exclusions, records);
}
export function recommendationRate(records: CaptureFact[]): MetricResult {
  const partitioned = partition(records, true);
  const included = partitioned.included.filter(({ recommendationEligible }) => recommendationEligible !== false);
  const exclusions = [...partitioned.exclusions, ...partitioned.included.filter(({ recommendationEligible }) => recommendationEligible === false).map(({ id }): MetricExclusion => ({ id, reason: "recommendation_not_eligible" }))];
  return result("recommendation_rate", included.filter(({ explicitlyRecommended }) => explicitlyRecommended).length, included.length, included.map(({ id }) => id), exclusions, records);
}
export function recommendationShare(records: CaptureFact[]): MetricResult {
  const { included, exclusions } = partition(records, true);
  return result("recommendation_share", included.reduce((sum, row) => sum + (row.recommendationSlots ?? 0), 0), included.reduce((sum, row) => sum + (row.trackedRecommendationSlots ?? 0), 0), included.map(({ id }) => id), exclusions, records);
}
export function firstChoiceRate(records: CaptureFact[]): MetricResult {
  const partitioned = partition(records, true);
  const included = partitioned.included.filter(({ recommendationEligible }) => recommendationEligible !== false);
  const exclusions = [...partitioned.exclusions, ...partitioned.included.filter(({ recommendationEligible }) => recommendationEligible === false).map(({ id }): MetricExclusion => ({ id, reason: "recommendation_not_eligible" }))];
  return result("first_choice_rate", included.filter(({ firstChoice }) => firstChoice).length, included.length, included.map(({ id }) => id), exclusions, records);
}
export function ownedCitationRate(records: CaptureFact[]): MetricResult {
  const { included, exclusions } = partition(records, false);
  return result("owned_citation_rate", included.filter(({ hasOwnedCitation }) => hasOwnedCitation).length, included.length, included.map(({ id }) => id), exclusions, records);
}
export function evidenceSupportRate(records: CaptureFact[]): MetricResult {
  const partitioned = partition(records, true);
  const included = partitioned.included.filter(({ totalClassifiedClaimCount, hasEvidence }) => (totalClassifiedClaimCount ?? (hasEvidence === undefined ? 0 : 1)) > 0);
  const exclusions = [...partitioned.exclusions, ...partitioned.included.filter((row) => !included.includes(row)).map(({ id }): MetricExclusion => ({ id, reason: "no_classified_claims" }))];
  return result("evidence_support_rate", included.reduce((sum, row) => sum + (row.supportedClaimCount ?? (row.hasEvidence ? 1 : 0)), 0), included.reduce((sum, row) => sum + (row.totalClassifiedClaimCount ?? 1), 0), included.map(({ id }) => id), exclusions, records);
}

export type ComparisonCohort = {
  coverage: number | null; questionIds: string[]; questionVersions?: string[]; providers: ProviderKey[]; models: string[];
  locales?: string[]; markets: string[]; classifierVersion: string; trackedBrandIds: string[]; competitorIds?: string[];
};
export type CompatibilityWarning = { code: "coverage_change" | "question_set_change" | "question_version_change" | "provider_set_change" | "model_change" | "locale_change" | "market_change" | "classifier_change" | "tracked_brand_change" | "competitor_change"; message: string; severity: "warning" | "blocking" };
const same = (a: string[] = [], b: string[] = []) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
export function comparisonCompatibility(a: ComparisonCohort, b: ComparisonCohort): CompatibilityWarning[] {
  const warnings: CompatibilityWarning[] = [];
  if (a.coverage !== b.coverage) warnings.push({ code: "coverage_change", message: "Capture coverage differs; answer-rate changes may reflect missing observations.", severity: "warning" });
  if (!same(a.questionIds, b.questionIds)) warnings.push({ code: "question_set_change", message: "Question sets differ.", severity: "blocking" });
  if (!same(a.questionVersions, b.questionVersions)) warnings.push({ code: "question_version_change", message: "Question versions differ.", severity: "blocking" });
  if (!same(a.providers, b.providers)) warnings.push({ code: "provider_set_change", message: "Provider sets differ.", severity: "blocking" });
  if (!same(a.models, b.models)) warnings.push({ code: "model_change", message: "Model or surface versions differ.", severity: "warning" });
  if (!same(a.locales, b.locales)) warnings.push({ code: "locale_change", message: "Locales differ.", severity: "blocking" });
  if (!same(a.markets, b.markets)) warnings.push({ code: "market_change", message: "Markets differ.", severity: "blocking" });
  if (a.classifierVersion !== b.classifierVersion) warnings.push({ code: "classifier_change", message: "Classifier versions differ.", severity: "warning" });
  if (!same(a.trackedBrandIds, b.trackedBrandIds)) warnings.push({ code: "tracked_brand_change", message: "Tracked brand sets differ, invalidating share comparisons.", severity: "blocking" });
  if (!same(a.competitorIds, b.competitorIds)) warnings.push({ code: "competitor_change", message: "Competitor cohorts differ.", severity: "blocking" });
  return warnings;
}

export type MetricSet = Record<MetricValue["key"], MetricResult>;
export function calculateMetrics(records: CaptureFact[], filter: MetricFilter = {}): MetricSet {
  const filtered = filterMetricRecords(records, filter);
  return { capture_coverage: captureCoverage(filtered), mention_rate: mentionRate(filtered), mention_share: mentionShare(filtered), recommendation_rate: recommendationRate(filtered), recommendation_share: recommendationShare(filtered), first_choice_rate: firstChoiceRate(filtered), owned_citation_rate: ownedCitationRate(filtered), evidence_support_rate: evidenceSupportRate(filtered) };
}
