import Link from "next/link";
import { DefinitionList, Notice, PageHeader, SectionHeading, StatCard } from "@/components/product-ui";
import { getUsageSummary, listProjects } from "@/lib/db";
import { getDashboardContext } from "../_context";

export const metadata = { title: "Usage" };

export default async function UsagePage() {
  const ctx = await getDashboardContext();
  const projects = await listProjects(ctx);
  const project = projects[0];
  const usage = project ? await getUsageSummary(ctx, project.id) : null;
  const totalTokens = usage ? usage.inputTokens + usage.outputTokens : null;
  const committedCalls = usage ? usage.calls + usage.reservedCalls : null;
  const committedCost = usage ? usage.estimatedCostUsd + usage.reservedCostUsd : null;
  return <>
    <PageHeader eyebrow="Usage and cost" title="No hidden fan-out." description="Understand this month’s stored provider calls, tokens, known estimated cost and workspace caps." />
    {!project ? <Notice title="No project usage" tone="warning"><p><Link className="text-link" href="/dashboard/setup">Create a project</Link> before provider usage can accrue.</p></Notice> : usage?.callLimit === 0 ? <Notice title="Call quota is not configured" tone="warning"><p>Usage is real, but a zero stored limit cannot be interpreted as an allowance. An administrator must configure quota before preflight can pass.</p></Notice> : null}
    {usage?.ambiguousEventCount ? <Notice title="Provider billing is not fully reconciled" tone="warning"><p>{usage.ambiguousEventCount.toLocaleString()} event{usage.ambiguousEventCount === 1 ? "" : "s"} ({usage.ambiguousCallCount.toLocaleString()} known call{usage.ambiguousCallCount === 1 ? "" : "s"}) may have reached a provider before a worker lease expired. Cost is shown as unknown rather than silently reported as zero; compare the provider invoice before relying on this total.</p></Notice> : null}
    <section className="stat-grid stat-grid-three"><StatCard label="Provider calls" value={usage ? usage.calls.toLocaleString() : "Unavailable"} detail="Stored calls across the workspace this UTC month." tone="accent" /><StatCard label="Estimated provider cost" value={usage ? `$${usage.estimatedCostUsd.toFixed(2)}` : "Unavailable"} detail="Known estimates from stored workspace usage events." /><StatCard label="Tokens" value={totalTokens === null ? "Unavailable" : totalTokens.toLocaleString()} detail="Input and output tokens combined." /></section>
    <div className="workspace-two-column workspace-section-spaced"><section className="workspace-card workspace-card-large"><SectionHeading title="Workspace usage ledger" description="Current-month actual usage; active reservations are shown separately." /><DefinitionList items={[{ term: "Input tokens", detail: usage?.inputTokens.toLocaleString() ?? "Unavailable" }, { term: "Output tokens", detail: usage?.outputTokens.toLocaleString() ?? "Unavailable" }, { term: "Actual calls", detail: usage?.calls.toLocaleString() ?? "Unavailable" }, { term: "Reserved calls", detail: usage?.reservedCalls.toLocaleString() ?? "Unavailable" }, { term: "Actual estimated cost", detail: usage ? `$${usage.estimatedCostUsd.toFixed(2)}` : "Unavailable" }, { term: "Incomplete usage records", detail: usage?.incompleteEventCount.toLocaleString() ?? "Unavailable" }, { term: "Reserved maximum cost", detail: usage ? `$${usage.reservedCostUsd.toFixed(2)}` : "Unavailable" }]} /></section><aside className="workspace-card"><SectionHeading title="Workspace limits" description="Hard caps include active run reservations." /><DefinitionList items={[{ term: "Monthly call cap", detail: usage?.callLimit ? usage.callLimit.toLocaleString() : "Not configured" }, { term: "Calls used or reserved", detail: committedCalls?.toLocaleString() ?? "Unavailable" }, { term: "Calls remaining", detail: usage?.callLimit && committedCalls !== null ? Math.max(0, usage.callLimit - committedCalls).toLocaleString() : "Not available" }, { term: "Known-cost cap", detail: usage?.costLimitUsd ? `$${usage.costLimitUsd.toFixed(2)}` : "Not configured" }, { term: "Cost used or reserved", detail: committedCost === null ? "Unavailable" : `$${committedCost.toFixed(2)}` }, { term: "Cost remaining", detail: usage?.costLimitUsd && committedCost !== null ? `$${Math.max(0, usage.costLimitUsd - committedCost).toFixed(2)}` : "Not available" }, { term: "Reset", detail: "First day of next UTC month" }]} /></aside></div>
    <p className="workspace-footnote">Provider-side billing remains authoritative. Stored estimated cost is not presented as an invoice.</p>
  </>;
}
