import Link from "next/link";
import { EmptyState, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { getRunPreflight, listProjects, listRuns } from "@/lib/db";
import { getDashboardContext } from "../_context";

export const metadata = { title: "Monitoring runs" };

function tone(status: string): "positive" | "warning" | "critical" | "neutral" {
  if (status === "succeeded") return "positive";
  if (status === "failed" || status === "cancelled") return "critical";
  if (status === "partial" || status === "running") return "warning";
  return "neutral";
}

export default async function RunsPage() {
  const ctx = await getDashboardContext();
  const projects = await listProjects(ctx);
  const project = projects[0];
  const [runs, preflight] = project ? await Promise.all([listRuns(ctx, project.id), getRunPreflight(ctx, project.id)]) : [[], null];
  return <>
    <PageHeader eyebrow="Monitoring runs" title="Every capture accounted for." description="Preflight call count, provider availability and quota before fan-out. Partial, failed and unavailable work stays visible." actions={<Link className="button button-small" href="/dashboard/runs/new">Prepare a run</Link>} />
    {!project ? <Notice title="Create a project first" tone="warning"><p><Link className="text-link" href="/dashboard/setup">Complete setup</Link> before preparing a run.</p></Notice> : preflight && !preflight.quota.ready ? <Notice title="Run preflight is blocked" tone="warning"><p>{preflight.quota.reason?.replaceAll("_", " ")}. Open preflight for remediation.</p></Notice> : null}
    <section className="workspace-card"><SectionHeading title="Run history" description={`${runs.length} total run${runs.length === 1 ? "" : "s"}`} action={<div className="legend" aria-label="Run status legend"><StatusChip tone="positive">Succeeded</StatusChip><StatusChip tone="warning">Partial</StatusChip><StatusChip tone="critical">Failed</StatusChip></div>} />
      {!runs.length ? <EmptyState title="No run history" description="Completed work will show its cohort, coverage, provider mix, cost, latency and every capture outcome." actionHref="/dashboard/runs/new" actionLabel="Open run preflight" /> : <div className="table-wrap"><table><caption>Monitoring runs for {project?.name}</caption><thead><tr><th scope="col">Created</th><th scope="col">Status</th><th scope="col">Requested captures</th><th scope="col">Started</th><th scope="col">Completed</th><th scope="col">Details</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td>{new Date(run.created_at).toLocaleString()}</td><td><StatusChip tone={tone(run.status)}>{run.status}</StatusChip></td><td>{run.requested_capture_count}</td><td>{run.started_at ? new Date(run.started_at).toLocaleString() : "—"}</td><td>{run.completed_at ? new Date(run.completed_at).toLocaleString() : "—"}</td><td><Link className="text-link" href={`/dashboard/runs/${run.id}`}>Open</Link></td></tr>)}</tbody></table></div>}
    </section>
    <p className="workspace-footnote">Runs follow <strong>queued → running → succeeded, partial, failed or cancelled</strong>. A partial run never appears complete.</p>
  </>;
}
