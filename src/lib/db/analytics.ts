import "server-only";

import {
  calculateMetrics,
  type CaptureFact,
  type MetricFilter,
  type MetricSet,
} from "@/lib/metrics";
import type { Json, ObservationRow, RunItemRow, RunRow } from "@/types/database";
import type { ProviderKey } from "@/types/contracts";
import { databaseFailure } from "./errors";
import { getProject } from "./repository";
import type { DbContext } from "./types";

type BrandRow = { id: string; workspace_id: string; project_id: string; name: string; domain: string; market: string; is_primary: boolean; role: "primary" | "competitor"; created_at: string; updated_at: string };
type BrandVersionRow = { id: string; workspace_id: string; project_id: string; brand_id: string; version: number; name: string; domain: string; role: "primary" | "competitor"; aliases: Json; snapshot_hash: string; created_by: string | null; created_at: string };
type QuestionVersionRow = { id: string; workspace_id: string; project_id: string; question_id: string; version: number; prompt: string; question_type: string; persona: string | null; stage: string | null; market: string; locale: string; rationale: string | null; qualification: Json; snapshot_hash: string; created_by: string | null; created_at: string };
type RunBrandVersionRow = { workspace_id: string; project_id: string; run_id: string; brand_version_id: string; role: "primary" | "competitor"; position: number; created_at: string };
type ClassificationRow = { id: string; workspace_id: string; project_id: string; classification_run_id: string; observation_id: string; brand_version_id: string; mentioned: boolean; cited: boolean; shortlisted: boolean; explicitly_recommended: boolean; first_choice: boolean; rejected: boolean; rank: number | null; confidence: number; evidence_spans: Json; rationale: string; review_status: string; created_at: string };
type ClassificationRunRow = { id: string; workspace_id: string; project_id: string; observation_id: string; classifier_name: string; classifier_version: string; input_hash: string; created_at: string };
type ReviewRow = { id: string; workspace_id: string; project_id: string; classification_id: string; reviewer_id: string | null; decision: "approved" | "overridden"; reason: string; before_value: Json; after_value: Json; created_at: string };
type CitationRow = { id: string; workspace_id: string; project_id: string; observation_id: string; url: string; original_url: string; canonical_url: string; title: string | null; position: number | null; evidence_excerpt: string | null; source_version_id: string | null; created_at: string };
export type IntelligenceFilter = {
  from?: string;
  to?: string;
  providers?: ProviderKey[];
  markets?: string[];
  locales?: string[];
  questionTypes?: string[];
  personas?: string[];
  competitorIds?: string[];
  runId?: string;
  questionSetId?: string;
};

export type AnalyticsRecord = {
  recordId: string;
  observationId: string | null;
  runItemId: string | null;
  runId: string;
  questionId: string;
  questionVersionId: string | null;
  prompt: string | null;
  provider: ProviderKey;
  model: string | null;
  market: string | null;
  locale: string | null;
  capturedAt: string;
  status: CaptureFact["status"];
  classificationState: CaptureFact["classificationState"];
  primaryFacts: ResolvedFacts | null;
  trackedFacts: Array<ResolvedFacts & { brandId: string; brandName: string; role: "primary" | "competitor"; classificationState: CaptureFact["classificationState"] }>;
  citationCount: number;
  ownedCitationCount: number;
  evidenceSupported: boolean;
  answerText: string | null;
};

export type ResolvedFacts = {
  mentioned: boolean;
  cited: boolean;
  shortlisted: boolean;
  explicitlyRecommended: boolean;
  firstChoice: boolean;
  rejected: boolean;
  rank: number | null;
};

export type DecisionOutcome = {
  questionId: string;
  prompt: string;
  market: string | null;
  locale: string | null;
  outcome: "won" | "lost" | "absent" | "unstable";
  successfulCaptures: number;
  eligibleCaptures: number;
  latestCapturedAt: string;
  latestRunId: string;
  rationale: string;
};

export type BrandPerformance = {
  brandId: string;
  name: string;
  domain: string;
  role: "primary" | "competitor";
  eligibleCaptures: number;
  mentions: number;
  recommendations: number;
  firstChoices: number;
};

export type CitationDomain = {
  domain: string;
  citations: number;
  observations: number;
  owned: boolean;
  latestCapturedAt: string;
  latestRunId: string;
};

export type IntelligenceAnalytics = {
  projectId: string;
  metrics: MetricSet;
  records: AnalyticsRecord[];
  decisions: DecisionOutcome[];
  brands: BrandPerformance[];
  citationDomains: CitationDomain[];
  limitations: Array<{ severity: "info" | "warning" | "blocking"; code: string; message: string }>;
  cohort: {
    runIds: string[];
    questionSetIds: string[];
    providers: ProviderKey[];
    models: string[];
    markets: string[];
    locales: string[];
    classifierVersions: string[];
  };
};

export type AnalyticsDataset = {
  observations: ObservationRow[];
  runItems: RunItemRow[];
  runs: RunRow[];
  brands: BrandRow[];
  brandVersions: BrandVersionRow[];
  questionVersions: QuestionVersionRow[];
  runBrandVersions: RunBrandVersionRow[];
  classifications: ClassificationRow[];
  classificationRuns: ClassificationRunRow[];
  reviews: ReviewRow[];
  citations: CitationRow[];
};

function rowsOrThrow<T>(data: T[] | null, error: unknown, message: string) {
  if (error) databaseFailure(message, error);
  return data ?? [];
}

function emptyResult<T>() {
  return Promise.resolve({ data: [] as T[], error: null });
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function asObject(value: Json): Record<string, Json | undefined> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function booleanFact(value: Json | undefined, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function numberFact(value: Json | undefined, fallback: number | null) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : value === null ? null : fallback;
}

function resolveFacts(row: ClassificationRow, review?: ReviewRow): ResolvedFacts {
  const override = review?.decision === "overridden" ? asObject(review.after_value) : null;
  return {
    mentioned: booleanFact(override?.mentioned, row.mentioned),
    cited: booleanFact(override?.cited, row.cited),
    shortlisted: booleanFact(override?.shortlisted, row.shortlisted),
    explicitlyRecommended: booleanFact(override?.explicitlyRecommended, row.explicitly_recommended),
    firstChoice: booleanFact(override?.firstChoice, row.first_choice),
    rejected: booleanFact(override?.rejected, row.rejected),
    rank: numberFact(override?.rank, row.rank),
  };
}

function classificationState(row: ClassificationRow | undefined, review?: ReviewRow): CaptureFact["classificationState"] {
  if (!row) return "unclassified";
  if (review) return "approved";
  if (row.review_status === "pending") return "pending_review";
  if (row.review_status === "approved" || row.review_status === "overridden") return "approved";
  if (row.review_status === "not_required") return "auto_accepted";
  return "rejected";
}

function hostname(value: string) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./u, ""); } catch { return null; }
}

function isOwnedDomain(candidate: string, ownedDomains: string[]) {
  const host = hostname(candidate);
  return Boolean(host && ownedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
}

function filterFacts(facts: CaptureFact[], filter: IntelligenceFilter): CaptureFact[] {
  const metricFilter: MetricFilter = {
    from: filter.from,
    to: filter.to,
    providers: filter.providers,
    markets: filter.markets,
    locales: filter.locales,
    questionTypes: filter.questionTypes,
    personas: filter.personas,
    competitorIds: filter.competitorIds,
  };
  const allowed = new Set(calculateMetrics(facts, metricFilter).capture_coverage.cohort.captureIds);
  return facts.filter((fact) => allowed.has(fact.id));
}

function observationOutcome(record: AnalyticsRecord) {
  const primary = record.primaryFacts;
  const competitors = record.trackedFacts.filter((fact) => fact.role === "competitor" && (fact.classificationState === "auto_accepted" || fact.classificationState === "approved"));
  if (primary?.firstChoice) return "won" as const;
  if (competitors.some((fact) => fact.firstChoice)) return "lost" as const;
  if (primary?.explicitlyRecommended) return "won" as const;
  if (competitors.some((fact) => fact.explicitlyRecommended)) return "lost" as const;
  return "absent" as const;
}

function captureStatus(item: RunItemRow | undefined, observation: ObservationRow | undefined): CaptureFact["status"] {
  if (observation) return observation.status;
  if (!item) return "failed";
  if (item.status === "leased") return "running";
  return item.status;
}

export function buildIntelligenceAnalytics(projectId: string, dataset: AnalyticsDataset, filter: IntelligenceFilter = {}): IntelligenceAnalytics {
  const runItems = new Map(dataset.runItems.map((row) => [row.id, row]));
  const questionVersions = new Map(dataset.questionVersions.map((row) => [row.id, row]));
  const brandVersions = new Map(dataset.brandVersions.map((row) => [row.id, row]));
  const latestReviews = new Map<string, ReviewRow>();
  for (const review of dataset.reviews) {
    const previous = latestReviews.get(review.classification_id);
    if (!previous || review.created_at > previous.created_at) latestReviews.set(review.classification_id, review);
  }
  const classificationsByObservation = new Map<string, ClassificationRow[]>();
  for (const row of dataset.classifications) classificationsByObservation.set(row.observation_id, [...(classificationsByObservation.get(row.observation_id) ?? []), row]);
  const citationsByObservation = new Map<string, CitationRow[]>();
  for (const row of dataset.citations) citationsByObservation.set(row.observation_id, [...(citationsByObservation.get(row.observation_id) ?? []), row]);
  const classifierById = new Map(dataset.classificationRuns.map((row) => [row.id, row]));
  const trackedByRun = new Map<string, string[]>();
  const competitorIdsByRun = new Map<string, string[]>();
  const ownedDomainsByRun = new Map<string, string[]>();
  for (const item of dataset.runBrandVersions) {
    const version = brandVersions.get(item.brand_version_id);
    trackedByRun.set(item.run_id, [...(trackedByRun.get(item.run_id) ?? []), version?.brand_id ?? item.brand_version_id]);
    if (item.role === "competitor" && version) {
      competitorIdsByRun.set(item.run_id, [...(competitorIdsByRun.get(item.run_id) ?? []), version.brand_id]);
    }
    if (item.role === "primary" && version) {
      const domain = hostname(version.domain);
      if (domain) ownedDomainsByRun.set(item.run_id, [...(ownedDomainsByRun.get(item.run_id) ?? []), domain]);
    }
  }

  const observationByRunItem = new Map(dataset.observations.flatMap((observation) => observation.run_item_id ? [[observation.run_item_id, observation] as const] : []));
  const recordInputs: Array<{ item?: RunItemRow; observation?: ObservationRow }> = [
    ...dataset.runItems.map((item) => ({ item, observation: observationByRunItem.get(item.id) })),
    ...dataset.observations.filter((observation) => !observation.run_item_id || !runItems.has(observation.run_item_id)).map((observation) => ({ observation })),
  ];
  const allRecords: AnalyticsRecord[] = recordInputs.map(({ item, observation }) => {
    const questionVersion = item ? questionVersions.get(item.question_version_id) : undefined;
    const classifications = observation ? classificationsByObservation.get(observation.id) ?? [] : [];
    const trackedFacts = classifications.flatMap((classification) => {
      const version = brandVersions.get(classification.brand_version_id);
      if (!version) return [];
      const review = latestReviews.get(classification.id);
      return [{ ...resolveFacts(classification, review), brandId: version.brand_id, brandName: version.name, role: version.role, classificationState: classificationState(classification, review) }];
    });
    const runId = observation?.run_id ?? item!.run_id;
    const frozenVersionIds = new Set(dataset.runBrandVersions.filter((entry) => entry.run_id === runId).map((entry) => entry.brand_version_id));
    const primaryClassification = classifications.find((classification) => frozenVersionIds.has(classification.brand_version_id) && brandVersions.get(classification.brand_version_id)?.role === "primary");
    const citations = observation ? citationsByObservation.get(observation.id) ?? [] : [];
    return {
      recordId: observation?.id ?? `run-item:${item!.id}`,
      observationId: observation?.id ?? null,
      runItemId: item?.id ?? observation?.run_item_id ?? null,
      runId,
      questionId: observation?.question_id ?? questionVersion?.question_id ?? "unknown-question",
      questionVersionId: item?.question_version_id ?? null,
      prompt: questionVersion?.prompt ?? null,
      provider: observation?.provider ?? item!.provider,
      model: observation?.model_or_surface ?? null,
      market: item?.market ?? questionVersion?.market ?? null,
      locale: item?.locale ?? questionVersion?.locale ?? null,
      capturedAt: observation?.captured_at ?? item?.completed_at ?? item?.started_at ?? item!.created_at,
      status: captureStatus(item, observation),
      classificationState: classificationState(primaryClassification, primaryClassification ? latestReviews.get(primaryClassification.id) : undefined),
      primaryFacts: primaryClassification ? resolveFacts(primaryClassification, latestReviews.get(primaryClassification.id)) : null,
      trackedFacts,
      citationCount: citations.length,
      ownedCitationCount: citations.filter((citation) => isOwnedDomain(citation.canonical_url, ownedDomainsByRun.get(runId) ?? [])).length,
      evidenceSupported: citations.some((citation) => Boolean(citation.source_version_id || citation.evidence_excerpt?.trim())),
      answerText: observation?.answer_text ?? null,
    };
  });

  const facts: CaptureFact[] = allRecords.map((record) => {
    const item = record.questionVersionId ? questionVersions.get(record.questionVersionId) : undefined;
    const classifications = record.observationId ? classificationsByObservation.get(record.observationId) ?? [] : [];
    const primary = record.primaryFacts;
    const classifierVersions = classifications.map((classification) => classifierById.get(classification.classification_run_id)?.classifier_version).filter((value): value is string => Boolean(value));
    return {
      id: record.recordId,
      status: record.status,
      classificationState: record.classificationState,
      classifierVersion: unique(classifierVersions).join("+") || undefined,
      provider: record.provider,
      model: record.model ?? undefined,
      locale: record.locale ?? undefined,
      market: record.market ?? undefined,
      questionId: record.questionId,
      questionVersion: record.questionVersionId ?? undefined,
      questionType: item?.question_type ?? undefined,
      persona: item?.persona ?? undefined,
      competitorIds: competitorIdsByRun.get(record.runId) ?? [],
      trackedBrandIds: trackedByRun.get(record.runId) ?? record.trackedFacts.map((fact) => fact.brandId),
      capturedAt: record.capturedAt,
      mentioned: primary?.mentioned ?? false,
      explicitlyRecommended: primary?.explicitlyRecommended ?? false,
      recommendationEligible: true,
      firstChoice: primary?.firstChoice ?? false,
      hasOwnedCitation: record.ownedCitationCount > 0,
      hasEvidence: record.evidenceSupported,
      supportedClaimCount: record.classificationState === "auto_accepted" || record.classificationState === "approved" ? (record.evidenceSupported ? 1 : 0) : 0,
      totalClassifiedClaimCount: record.classificationState === "auto_accepted" || record.classificationState === "approved" ? 1 : 0,
      brandOccurrences: primary?.mentioned ? 1 : 0,
      trackedBrandOccurrences: record.trackedFacts.filter((fact) => (fact.classificationState === "auto_accepted" || fact.classificationState === "approved") && fact.mentioned).length,
      recommendationSlots: primary?.explicitlyRecommended ? 1 : 0,
      trackedRecommendationSlots: record.trackedFacts.filter((fact) => (fact.classificationState === "auto_accepted" || fact.classificationState === "approved") && fact.explicitlyRecommended).length,
    };
  });
  const filteredFacts = filterFacts(facts, filter);
  const selectedIds = new Set(filteredFacts.map((fact) => fact.id));
  const records = allRecords.filter((record) => selectedIds.has(record.recordId));
  const metrics = calculateMetrics(filteredFacts);

  const grouped = new Map<string, AnalyticsRecord[]>();
  for (const record of records.filter((item) => item.status === "succeeded")) grouped.set(record.questionId, [...(grouped.get(record.questionId) ?? []), record]);
  const decisions: DecisionOutcome[] = [...grouped.entries()].flatMap(([questionId, questionRecords]) => {
    const eligible = questionRecords.filter((record) => record.classificationState === "auto_accepted" || record.classificationState === "approved");
    if (!eligible.length) return [];
    const states = unique(eligible.map(observationOutcome));
    const outcome: DecisionOutcome["outcome"] = states.length > 1 ? "unstable" : states[0] ?? "absent";
    const latest = questionRecords.toSorted((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0]!;
    const rationale = outcome === "unstable" ? "Eligible captures disagree across the selected cohort."
      : outcome === "won" ? "The primary brand is recommended or ranked first in every eligible capture."
        : outcome === "lost" ? "A tracked competitor is preferred in every eligible capture."
          : "No tracked brand is preferred in the eligible captures.";
    return [{ questionId, prompt: latest.prompt ?? "Stored question", market: latest.market, locale: latest.locale, outcome, successfulCaptures: questionRecords.length, eligibleCaptures: eligible.length, latestCapturedAt: latest.capturedAt, latestRunId: latest.runId, rationale }];
  }).toSorted((a, b) => b.latestCapturedAt.localeCompare(a.latestCapturedAt));

  const selectedRunIds = new Set(records.map((record) => record.runId));
  const selectedVersionIds = new Set(dataset.runBrandVersions.filter((entry) => selectedRunIds.has(entry.run_id)).map((entry) => entry.brand_version_id));
  const performanceVersions = new Map<string, BrandVersionRow>();
  for (const version of dataset.brandVersions.filter((entry) => selectedVersionIds.has(entry.id))) {
    const prior = performanceVersions.get(version.brand_id);
    if (!prior || version.created_at > prior.created_at) performanceVersions.set(version.brand_id, version);
  }
  const brandPerformance = [...performanceVersions.values()].map<BrandPerformance>((brand) => {
    const relevant = records.flatMap((record) => record.trackedFacts.filter((fact) => fact.brandId === brand.brand_id).map((facts) => ({ record, facts }))).filter(({ record, facts }) => record.status === "succeeded" && (facts.classificationState === "auto_accepted" || facts.classificationState === "approved"));
    return { brandId: brand.brand_id, name: brand.name, domain: brand.domain, role: brand.role, eligibleCaptures: relevant.length, mentions: relevant.filter(({ facts: value }) => value.mentioned).length, recommendations: relevant.filter(({ facts: value }) => value.explicitlyRecommended).length, firstChoices: relevant.filter(({ facts: value }) => value.firstChoice).length };
  }).toSorted((a, b) => b.firstChoices - a.firstChoices || b.recommendations - a.recommendations || a.name.localeCompare(b.name));

  const recordIds = new Set(records.flatMap((record) => record.observationId ? [record.observationId] : []));
  const citationAccumulator = new Map<string, { citations: number; observationIds: Set<string>; owned: boolean; latestCapturedAt: string; latestObservationId: string }>();
  const capturedAt = new Map(records.flatMap((record) => record.observationId ? [[record.observationId, record.capturedAt] as const] : []));
  const runByObservation = new Map(records.flatMap((record) => record.observationId ? [[record.observationId, record.runId] as const] : []));
  for (const citation of dataset.citations.filter((row) => recordIds.has(row.observation_id))) {
    const domain = hostname(citation.canonical_url);
    if (!domain) continue;
    const citationTime = capturedAt.get(citation.observation_id) ?? citation.created_at;
    const citationRunId = runByObservation.get(citation.observation_id) ?? "";
    const citationOwned = isOwnedDomain(citation.canonical_url, ownedDomainsByRun.get(citationRunId) ?? []);
    const previous = citationAccumulator.get(domain) ?? { citations: 0, observationIds: new Set<string>(), owned: citationOwned, latestCapturedAt: citationTime, latestObservationId: citation.observation_id };
    previous.citations += 1;
    previous.owned = previous.owned || citationOwned;
    previous.observationIds.add(citation.observation_id);
    if (citationTime > previous.latestCapturedAt) { previous.latestCapturedAt = citationTime; previous.latestObservationId = citation.observation_id; }
    citationAccumulator.set(domain, previous);
  }
  const citationDomains = [...citationAccumulator.entries()].map<CitationDomain>(([domain, value]) => ({ domain, citations: value.citations, observations: value.observationIds.size, owned: value.owned, latestCapturedAt: value.latestCapturedAt, latestRunId: runByObservation.get(value.latestObservationId) ?? "" })).toSorted((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain));

  const selectedRuns = dataset.runs.filter((run) => unique(records.map((record) => record.runId)).includes(run.id));
  const cohort = {
    runIds: unique(records.map((record) => record.runId)).sort(),
    questionSetIds: unique(selectedRuns.flatMap((run) => run.question_set_id ? [run.question_set_id] : [])).sort(),
    providers: unique(records.map((record) => record.provider)).sort(),
    models: unique(records.flatMap((record) => record.model ? [record.model] : [])).sort(),
    markets: unique(records.flatMap((record) => record.market ? [record.market] : [])).sort(),
    locales: unique(records.flatMap((record) => record.locale ? [record.locale] : [])).sort(),
    classifierVersions: unique(filteredFacts.flatMap((fact) => fact.classifierVersion ? [fact.classifierVersion] : [])).sort(),
  };
  const limitations: IntelligenceAnalytics["limitations"] = [];
  if (!records.length) limitations.push({ severity: "info", code: "empty_cohort", message: "No observation records match the selected cohort." });
  if (cohort.questionSetIds.length > 1) limitations.push({ severity: "blocking", code: "question_set_change", message: "The selected records span multiple immutable question sets; do not interpret movement as like-for-like." });
  const versionsByQuestion = new Map<string, Set<string>>();
  for (const record of records) if (record.questionVersionId) versionsByQuestion.set(record.questionId, (versionsByQuestion.get(record.questionId) ?? new Set()).add(record.questionVersionId));
  if ([...versionsByQuestion.values()].some((versions) => versions.size > 1)) limitations.push({ severity: "blocking", code: "question_version_change", message: "At least one question changed version inside the selected cohort." });
  if (cohort.classifierVersions.length > 1) limitations.push({ severity: "warning", code: "classifier_change", message: "The selected records span multiple classifier versions." });
  const reviewExcluded = filteredFacts.filter((fact) => fact.classificationState === "pending_review" || fact.classificationState === "unclassified").length;
  if (reviewExcluded) limitations.push({ severity: "warning", code: "classification_exclusions", message: `${reviewExcluded} successful or attempted capture${reviewExcluded === 1 ? " is" : "s are"} excluded from classification metrics because review is pending or classification is missing.` });
  limitations.push({ severity: "info", code: "evidence_support_definition", message: "Evidence support counts an eligible classified observation only when a citation has a captured evidence passage or immutable managed-source lineage; a URL alone is not treated as verified support." });
  return { projectId, metrics, records, decisions, brands: brandPerformance, citationDomains, limitations, cohort };
}

export async function getIntelligenceAnalytics(ctx: DbContext, projectId: string, filter: IntelligenceFilter = {}) {
  await getProject(ctx, projectId);
  const client = ctx.client;
  const [observationResult, brandResult, runResult] = await Promise.all([
    client.from("observations").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).order("captured_at", { ascending: false }),
    client.from("brands").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).order("created_at"),
    client.from("runs").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).order("created_at", { ascending: false }),
  ]);
  const observations = rowsOrThrow(observationResult.data, observationResult.error, "Unable to load analytics observations.");
  const brands = rowsOrThrow(brandResult.data, brandResult.error, "Unable to load analytics brands.");
  let runs = rowsOrThrow(runResult.data, runResult.error, "Unable to load analytics runs.");
  if (filter.runId) runs = runs.filter((run) => run.id === filter.runId);
  if (filter.questionSetId) runs = runs.filter((run) => run.question_set_id === filter.questionSetId);
  const runIds = runs.map((run) => run.id);
  const allowedRunIds = new Set(runIds);
  const selectedObservations = observations.filter((observation) => allowedRunIds.has(observation.run_id));
  const observationIds = selectedObservations.map((row) => row.id);
  const [classificationResult, citationResult, runItemResult, runBrandResult] = await Promise.all([
    observationIds.length ? client.from("brand_classifications").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).in("observation_id", observationIds) : emptyResult<ClassificationRow>(),
    observationIds.length ? client.from("citations").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).in("observation_id", observationIds) : emptyResult<CitationRow>(),
    runIds.length ? client.from("run_items").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).in("run_id", runIds) : emptyResult<RunItemRow>(),
    runIds.length ? client.from("run_brand_versions").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).in("run_id", runIds) : emptyResult<RunBrandVersionRow>(),
  ]);
  const classifications = rowsOrThrow(classificationResult.data, classificationResult.error, "Unable to load analytics classifications.");
  const citations = rowsOrThrow(citationResult.data, citationResult.error, "Unable to load analytics citations.");
  const runItems = rowsOrThrow(runItemResult.data, runItemResult.error, "Unable to load analytics run items.");
  const runBrandVersions = rowsOrThrow(runBrandResult.data, runBrandResult.error, "Unable to load analytics run brand versions.");
  const questionVersionIds = unique(runItems.map((row) => row.question_version_id));
  const classificationIds = classifications.map((row) => row.id);
  const classificationRunIds = unique(classifications.map((row) => row.classification_run_id));
  const brandVersionIds = unique([...classifications.map((row) => row.brand_version_id), ...runBrandVersions.map((row) => row.brand_version_id)]);
  const [questionVersionResult, brandVersionResult, classificationRunResult, reviewResult] = await Promise.all([
    questionVersionIds.length ? client.from("question_versions").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).in("id", questionVersionIds) : emptyResult<QuestionVersionRow>(),
    brandVersionIds.length ? client.from("brand_versions").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).in("id", brandVersionIds) : emptyResult<BrandVersionRow>(),
    classificationRunIds.length ? client.from("classification_runs").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).in("id", classificationRunIds) : emptyResult<ClassificationRunRow>(),
    classificationIds.length ? client.from("classification_reviews").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).in("classification_id", classificationIds).order("created_at") : emptyResult<ReviewRow>(),
  ]);
  return buildIntelligenceAnalytics(projectId, {
    observations: selectedObservations,
    runItems,
    runs,
    brands,
    brandVersions: rowsOrThrow(brandVersionResult.data, brandVersionResult.error, "Unable to load analytics brand versions."),
    questionVersions: rowsOrThrow(questionVersionResult.data, questionVersionResult.error, "Unable to load analytics question versions."),
    runBrandVersions,
    classifications,
    classificationRuns: rowsOrThrow(classificationRunResult.data, classificationRunResult.error, "Unable to load classifier versions."),
    reviews: rowsOrThrow(reviewResult.data, reviewResult.error, "Unable to load classification reviews."),
    citations,
  }, filter);
}

export async function listMetricRecords(ctx: DbContext, projectId: string, metricKey: keyof MetricSet, filter: IntelligenceFilter = {}) {
  const analytics = await getIntelligenceAnalytics(ctx, projectId, filter);
  const metric = analytics.metrics[metricKey];
  const included = new Set(metric.includedIds);
  const exclusion = new Map(metric.exclusions.map((item) => [item.id, item.reason]));
  return analytics.records.map((record) => ({
    ...record,
    included: included.has(record.recordId),
    exclusionReason: exclusion.get(record.recordId) ?? null,
  }));
}
