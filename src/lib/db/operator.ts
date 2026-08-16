import "server-only";

import type { MetricValue } from "@/types/contracts";
import { getIntelligenceAnalytics } from "./analytics";
import { listActions, listEvidence, listRuns } from "./repository";
import type { DbContext } from "./types";

export const operatorIntents = ["run_status", "review_queue", "find_evidence", "explain_metric", "next_actions"] as const;
export type OperatorIntent = typeof operatorIntents[number];
export type OperatorResult = {
  intent: OperatorIntent;
  heading: string;
  answer: string;
  facts: Array<{ label: string; value: string }>;
  links: Array<{ label: string; href: string }>;
  asOf: string | null;
  limitations: string[];
};

const metricLabels: Record<MetricValue["key"], string> = {
  capture_coverage: "Capture coverage",
  mention_rate: "Mention rate",
  mention_share: "Mention share",
  recommendation_rate: "Recommendation rate",
  recommendation_share: "Recommendation share",
  first_choice_rate: "First-choice rate",
  owned_citation_rate: "Owned citation rate",
  evidence_support_rate: "Evidence support rate",
};

function percentage(value: number | null) {
  return value === null ? "Not calculated" : `${(value * 100).toFixed(1)}%`;
}

export async function runOperatorQuery(ctx: DbContext, input: {
  projectId: string;
  intent: OperatorIntent;
  metricKey?: MetricValue["key"];
}): Promise<OperatorResult> {
  if (!operatorIntents.includes(input.intent)) throw new TypeError("Unsupported operator intent.");

  if (input.intent === "run_status") {
    const runs = await listRuns(ctx, input.projectId);
    const latest = runs[0];
    if (!latest) return { intent: input.intent, heading: "Run status", answer: "No monitoring run has been requested for this project.", facts: [{ label: "Runs", value: "0" }], links: [{ label: "Open preflight", href: "/dashboard/runs/new" }], asOf: null, limitations: [] };
    return {
      intent: input.intent,
      heading: "Latest run status",
      answer: `The latest durable run is ${latest.status}.`,
      facts: [{ label: "Status", value: latest.status }, { label: "Requested captures", value: String(latest.requested_capture_count) }, { label: "Created", value: latest.created_at }],
      links: [{ label: "Open latest run", href: `/dashboard/runs/${latest.id}` }, { label: "All runs", href: "/dashboard/runs" }],
      asOf: latest.completed_at ?? latest.started_at ?? latest.created_at,
      limitations: latest.status === "queued" || latest.status === "running" ? ["This status can change as durable jobs complete; refresh to read the repository again."] : [],
    };
  }

  if (input.intent === "review_queue") {
    const analytics = await getIntelligenceAnalytics(ctx, input.projectId);
    const pendingRecords = analytics.records.filter((record) => record.trackedFacts.some((fact) => fact.classificationState === "pending_review"));
    const pendingCount = pendingRecords.reduce((count, record) => count + record.trackedFacts.filter((fact) => fact.classificationState === "pending_review").length, 0);
    const oldest = pendingRecords.toSorted((a, b) => a.capturedAt.localeCompare(b.capturedAt))[0];
    return {
      intent: input.intent,
      heading: "Classification review queue",
      answer: pendingCount ? `${pendingCount} classification${pendingCount === 1 ? " requires" : "s require"} human review.` : "No classification review is currently pending.",
      facts: [{ label: "Pending", value: String(pendingCount) }, ...(oldest ? [{ label: "Oldest capture", value: oldest.capturedAt }] : [])],
      links: [{ label: pendingCount ? "Review classifications" : "Open review queue", href: "/dashboard/questions/review" }],
      asOf: oldest?.capturedAt ?? null,
      limitations: ["Question-quality review items are not included in this classification-only count."],
    };
  }

  if (input.intent === "find_evidence") {
    const [sources, analytics] = await Promise.all([listEvidence(ctx, input.projectId), getIntelligenceAnalytics(ctx, input.projectId)]);
    const leadingDomain = analytics.citationDomains[0];
    return {
      intent: input.intent,
      heading: "Evidence and citations",
      answer: `${sources.length} managed source${sources.length === 1 ? " is" : "s are"} stored and ${analytics.citationDomains.length} citation domain${analytics.citationDomains.length === 1 ? " appears" : "s appear"} in the selected project history.`,
      facts: [{ label: "Managed sources", value: String(sources.length) }, { label: "Citation domains", value: String(analytics.citationDomains.length) }, { label: "Leading domain", value: leadingDomain?.domain ?? "None" }],
      links: [{ label: "Evidence library", href: "/dashboard/evidence" }, { label: "Evidence analytics", href: "/dashboard/analytics/evidence" }],
      asOf: leadingDomain?.latestCapturedAt ?? sources[0]?.updated_at ?? null,
      limitations: analytics.limitations.filter((item) => item.code === "evidence_support_definition").map((item) => item.message),
    };
  }

  if (input.intent === "explain_metric") {
    const metricKey = input.metricKey ?? "recommendation_share";
    if (!(metricKey in metricLabels)) throw new TypeError("Unsupported metric key.");
    const analytics = await getIntelligenceAnalytics(ctx, input.projectId);
    const metric = analytics.metrics[metricKey];
    return {
      intent: input.intent,
      heading: metricLabels[metricKey],
      answer: `${metricLabels[metricKey]} is ${percentage(metric.value)} for cohort ${metric.cohortKey}.`,
      facts: [{ label: "Numerator", value: String(metric.numerator) }, { label: "Denominator", value: String(metric.denominator) }, { label: "Formula", value: metric.formula }, { label: "Metric version", value: metric.metricVersion }],
      links: [{ label: "Open analytics", href: `/dashboard/analytics?metric=${metricKey}` }],
      asOf: metric.cohort.to ?? null,
      limitations: analytics.limitations.map((item) => item.message),
    };
  }

  const actions = await listActions(ctx, input.projectId);
  const open = actions.filter((action) => action.status !== "completed" && action.status !== "dismissed");
  const next = open[0];
  return {
    intent: input.intent,
    heading: "Next actions",
    answer: next ? `${open.length} action${open.length === 1 ? " remains" : "s remain"} open. The most recently updated is “${next.title}”.` : "No action is currently open for this project.",
    facts: [{ label: "Open actions", value: String(open.length) }, ...(next ? [{ label: "Next status", value: next.status.replaceAll("_", " ") }, { label: "Expected impact", value: next.expected_impact ?? "Not specified" }] : [])],
    links: [{ label: open.length ? "Open action backlog" : "Create an action", href: "/dashboard/actions" }],
    asOf: next?.updated_at ?? null,
    limitations: ["Ordering follows repository update time; RefineStack does not infer business priority without an explicit prioritization field."],
  };
}
