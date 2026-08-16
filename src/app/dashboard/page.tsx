import Link from "next/link";
import { EmptyState, Notice, PageHeader, SectionHeading, StatCard, StatusChip } from "@/components/product-ui";
import { getProductSnapshot } from "@/lib/db";
import { getDashboardContext } from "./_context";

export const metadata = { title: "Workspace overview" };

export default async function DashboardOverview() {
  const ctx = await getDashboardContext();
  const snapshot = await getProductSnapshot(ctx);
  const healthyProvider = snapshot.providers.some((provider) => provider.enabled && provider.state === "healthy");
  const baseline = snapshot.recentRuns.some((run) => run.status === "succeeded" || run.status === "partial");
  const readiness = [
    ["Project definition", "Brand, category and markets", !snapshot.setup.missing.includes("project") && !snapshot.setup.missing.includes("category")],
    ["Decision questions", "Typed, reviewed and active", !snapshot.setup.missing.includes("question")],
    ["Provider access", "At least one healthy capture path", healthyProvider],
    ["Baseline run", "Preflight approved and completed", baseline],
  ] as const;

  return <>
    <PageHeader eyebrow="Workspace overview" title="Know where AI decisions are being won." description="RefineStack keeps the question, answer, recommendation, evidence and next action connected. Metrics appear only after provenance-backed captures succeed." actions={<Link className="button button-small" href="/dashboard/setup">Manage project</Link>} />
    {!snapshot.setup.complete ? <Notice title="Study setup is incomplete" tone="info"><p>Missing: {snapshot.setup.missing.join(", ").replaceAll("_", " ")}. Complete setup before interpreting a baseline.</p></Notice> : null}
    <section className="stat-grid" aria-label="Workspace metrics">
      <StatCard label="Projects" value={String(snapshot.counts.projects)} detail="Projects visible to this workspace." tone="accent" />
      <StatCard label="Questions" value={String(snapshot.counts.questions)} detail="Questions across workspace projects." />
      <StatCard label="Decisions requiring review" value={String(snapshot.pendingReviewCount)} detail="Pending human classification reviews." />
      <StatCard label="Tracked actions" value={String(snapshot.counts.actions)} detail="All action states in this workspace." />
    </section>
    <div className="workspace-two-column">
      <section className="workspace-card workspace-card-large">
        <SectionHeading title="Decision movement" description="Recommendation movement appears after comparable successful cohorts exist." />
        <div className="chart-empty" role="img" aria-label="Decision movement is not calculated by the current repository contract"><span className="chart-axis-label">Not calculated</span><div aria-hidden="true"><i /><i /><i /><i /></div><p>Run the same approved questions over time to reveal won, lost, absent and unstable decisions.</p></div>
      </section>
      <section className="workspace-card">
        <SectionHeading title="Study readiness" description="Required foundations for a valid baseline." />
        <ol className="readiness-list">{readiness.map(([title, detail, ready]) => <li key={title}><StatusChip tone={ready ? "positive" : "warning"}>{ready ? "Ready" : "Waiting"}</StatusChip><span><strong>{title}</strong><small>{detail}</small></span></li>)}</ol>
      </section>
    </div>
    <section className="workspace-card workspace-section-spaced">
      <SectionHeading title="Recent monitoring" description="Every requested capture remains visible, including failures and unavailable providers." action={<Link className="text-link" href="/dashboard/runs">View all runs</Link>} />
      {snapshot.recentRuns.length ? <div className="table-wrap"><table><caption>Five most recent runs</caption><thead><tr><th scope="col">Created</th><th scope="col">State</th><th scope="col">Requested</th><th scope="col">Details</th></tr></thead><tbody>{snapshot.recentRuns.map((run) => <tr key={run.id}><td>{new Date(run.createdAt).toLocaleString()}</td><td><StatusChip tone={run.status === "succeeded" ? "positive" : run.status === "failed" ? "critical" : "warning"}>{run.status}</StatusChip></td><td>{run.requestedCaptureCount}</td><td><Link className="text-link" href={`/dashboard/runs/${run.id}`}>Open run</Link></td></tr>)}</tbody></table></div> : <EmptyState title="No monitoring runs yet" description="A run can start only after a project has active questions and at least one configured provider passes preflight." actionHref="/dashboard/setup" actionLabel="Start with project setup" />}
    </section>
  </>;
}
