import Link from "next/link";
import { randomUUID } from "node:crypto";
import { DefinitionList, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { SubmitButton } from "@/components/submit-button";
import { getRunPreflight, listProjects } from "@/lib/db";
import { providers } from "@/lib/providers";
import { requestRunAction } from "../../_actions";
import { canWrite, getDashboardContext } from "../../_context";

export const metadata = { title: "Run preflight" };

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const blockedReason = {
  quota_not_configured: "An administrator must configure both monthly call and cost limits.",
  no_active_questions: "Activate at least one question before requesting a run.",
  invalid_question_quality: "Fix or disqualify every active question flagged in the question library before requesting a run.",
  no_available_provider: "Enable a provider and complete a successful health check before requesting a run.",
  provider_budget_unavailable: "A selected provider has no authoritative server budget cap. An operator must configure it before calls can start.",
  insufficient_calls: "The remaining monthly call allowance cannot cover the maximum request.",
  insufficient_cost: "The remaining monthly cost allowance cannot cover the maximum request.",
  insufficient_calls_and_cost: "Neither the remaining monthly call nor cost allowance can cover the maximum request.",
} as const;

export default async function RunPreflightPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [ctx, query] = await Promise.all([getDashboardContext(), searchParams]);
  const projects = await listProjects(ctx);
  const project = projects[0];
  const preflight = project ? await getRunPreflight(ctx, project.id) : null;
  const writable = canWrite(ctx.actor.role);
  const ready = Boolean(preflight?.quota.ready && writable);
  return <>
    <PageHeader eyebrow="Run preflight" title="Know the work before it runs." description="RefineStack calculates the exact active-question and configured-provider fan-out, then blocks invalid or over-quota execution before any provider call." />
    {query.error ? <Notice title="Run was not requested" tone="critical"><p>{query.error}</p></Notice> : null}
    {!writable ? <Notice title="Read-only access" tone="warning"><p>Your {ctx.actor.role} role cannot request monitoring runs.</p></Notice> : null}
    <div className="preflight-layout">
      <section className="workspace-card workspace-card-large"><SectionHeading title="Capture cohort" description="The current active immutable question versions and enabled provider surfaces." />
        {!project ? <Notice title="Project missing" tone="warning"><p><Link className="text-link" href="/dashboard/setup">Create a project</Link> first.</p></Notice> : preflight?.quota.reason ? <Notice title="Preflight blocked" tone="warning"><p>{blockedReason[preflight.quota.reason]}</p></Notice> : <Notice title="Preflight passed" tone="info"><p>The server-authoritative maximum fits both monthly call and cost limits.</p></Notice>}
        <SectionHeading title="Provider access" description="Enabled healthy providers are selected. A newly configured provider may run once while unchecked so RefineStack can establish real health; degraded, unavailable and disabled providers remain blocked." />
        <ul className="provider-health-list">{(preflight?.providers ?? []).map((provider) => { const definition = providers.find((item) => item.key === provider.provider); const selected = preflight?.selectedProviderKeys.includes(provider.provider); return <li key={provider.provider}><div><strong>{definition?.name ?? provider.provider}</strong><small>{definition?.surface ?? "Provider surface"}</small></div><div className="provider-status"><StatusChip tone={selected ? "positive" : provider.state === "degraded" ? "warning" : "critical"}>{selected ? "Selected" : provider.state}</StatusChip><small>{provider.remediation ?? `Checked ${provider.lastCheckedAt ? new Date(provider.lastCheckedAt).toLocaleString() : "not yet"}`}</small></div></li>;})}</ul>
        <SectionHeading title="Authoritative provider budgets" description="Each selected provider has a server-owned worst-case cap per question capture. These values are enforcement limits, not invoice estimates." />
        {preflight?.providerBudgetAssumptions.length ? <ul className="provider-health-list">{preflight.providerBudgetAssumptions.map((budget) => {
          const definition = providers.find((item) => item.key === budget.provider);
          return <li key={budget.provider}><div><strong>{definition?.name ?? budget.provider}</strong><small>{budget.rationale}</small></div><div className="provider-status"><strong>{budget.maxCallsPerCapture} calls · {usd.format(budget.maxCostPerCaptureUsd)}</strong><small>Maximum per question · updated {new Date(budget.updatedAt).toLocaleDateString()}</small></div></li>;
        })}</ul> : <Notice title="Provider budgets unavailable" tone="warning"><p>No authoritative budget assumptions are available for the currently selected providers.</p></Notice>}
        {preflight?.providersMissingBudgetCaps.length ? <p className="workspace-footnote">Missing caps: {preflight.providersMissingBudgetCaps.map((provider) => providers.find((item) => item.key === provider)?.name ?? provider).join(", ")}.</p> : null}
        {preflight?.invalidQuestionIds.length ? <p className="workspace-footnote"><Link className="text-link" href="/dashboard/questions">Review {preflight.invalidQuestionIds.length} invalid active question{preflight.invalidQuestionIds.length === 1 ? "" : "s"}</Link> before this cohort can run.</p> : null}
      </section>
      <aside className="workspace-card preflight-summary"><SectionHeading title="Maximum reservation" description="No provider calls have been made. Current-month usage includes active run reservations across the entire workspace." /><DefinitionList items={[{ term: "Questions", detail: preflight ? preflight.activeQuestionVersionIds.length : "Unavailable" }, { term: "Healthy providers", detail: preflight ? preflight.selectedProviderKeys.length : "Unavailable" }, { term: "Requested captures", detail: preflight?.estimatedCaptureCount ?? "Unavailable" }, { term: "Maximum calls", detail: preflight?.quota.requiredCalls ?? "Unavailable" }, { term: "Maximum cost", detail: preflight ? usd.format(preflight.quota.requiredCostUsd) : "Unavailable" }, { term: "Calls used or reserved", detail: preflight?.quota.callsUsed ?? "Unavailable" }, { term: "Calls remaining", detail: preflight?.quota.callsRemaining ?? "Not configured" }, { term: "Call shortfall", detail: preflight?.quota.callShortfall ?? "Unavailable" }, { term: "Cost used or reserved", detail: preflight ? usd.format(preflight.quota.costUsedUsd) : "Unavailable" }, { term: "Cost remaining", detail: preflight?.quota.costRemainingUsd === null || preflight?.quota.costRemainingUsd === undefined ? "Not configured" : usd.format(preflight.quota.costRemainingUsd) }, { term: "Cost shortfall", detail: preflight ? usd.format(preflight.quota.costShortfallUsd) : "Unavailable" }, { term: "Coverage", detail: preflight?.quota.ready ? "Ready" : "Blocked" }]} />
        {project ? <form action={requestRunAction}><fieldset className="action-fieldset" disabled={!ready}><input type="hidden" name="projectId" value={project.id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} /><SubmitButton className="button" pendingLabel="Requesting run…">Start monitoring run</SubmitButton></fieldset></form> : <Link className="button" href="/dashboard/setup">Create project</Link>}
        {!ready && project ? <p>The start action is blocked until preflight passes and your role allows writes.</p> : <p>Starting creates durable queued jobs. The database recalculates the reservation atomically, so this screen cannot authorize stale or client-edited values.</p>}
      </aside>
    </div>
  </>;
}
