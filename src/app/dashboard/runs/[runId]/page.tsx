import Link from "next/link";
import { DefinitionList, EmptyState, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { SubmitButton } from "@/components/submit-button";
import { getRun, listObservations } from "@/lib/db";
import { canWrite, getDashboardContext } from "../../_context";
import { cancelRunAction } from "./actions";

export const metadata = { title: "Run detail" };

export default async function RunDetailPage({ params, searchParams }: { params: Promise<{ runId: string }>; searchParams: Promise<{ saved?: string; error?: string }> }) {
  const [{ runId }, ctx, query] = await Promise.all([params, getDashboardContext(), searchParams]);
  const run = await getRun(ctx, runId);
  const observations = await listObservations(ctx, { projectId: run.project_id, runId });
  const counts = observations.reduce<Record<string, number>>((result, observation) => ({ ...result, [observation.status]: (result[observation.status] ?? 0) + 1 }), {});
  const observed = observations.length;
  const coverage = run.requested_capture_count ? observed / run.requested_capture_count * 100 : null;
  const cancellable = run.status === "queued" || run.status === "running";
  const writable = canWrite(ctx.actor.role);
  return <>
    <PageHeader eyebrow="Monitoring run" title={`Run ${run.status}.`} description="This durable record preserves the requested cohort, state, progress, captured answers and every failure reason." actions={<Link className="button button-secondary button-small" href="/dashboard/runs">Back to run history</Link>} />
    {query.saved ? <Notice title="Run updated" tone="info"><p>{query.saved}</p></Notice> : null}
    {query.error ? <Notice title="Run change failed" tone="critical"><p>{query.error}</p></Notice> : null}
    <div className="workspace-two-column">
      <section className="workspace-card workspace-card-large"><SectionHeading title="Capture outcomes" description={`${counts.succeeded ?? 0} succeeded · ${counts.failed ?? 0} failed · ${counts.unavailable ?? 0} unavailable`} />{!observations.length ? <EmptyState title="No observation records yet" description={run.status === "queued" || run.status === "running" ? "The run is awaiting or processing capture jobs. Refresh to load durable outcomes." : "No observation was stored for this run."} /> : <div className="record-stack">{observations.map((observation) => <article className="record-card open" key={observation.id}><div className="record-summary"><span><strong>{observation.provider} · {observation.model_or_surface ?? "surface not recorded"}</strong><small>{observation.access_method} · {new Date(observation.captured_at).toLocaleString()}</small></span><StatusChip tone={observation.status === "succeeded" ? "positive" : observation.status === "failed" ? "critical" : "warning"}>{observation.status}</StatusChip></div><div className="record-body">{observation.answer_text ? <p className="answer-excerpt">{observation.answer_text}</p> : <p>{observation.error_code ?? "No answer text"}: {observation.error_message ?? "No provider error detail was stored."}</p>}</div></article>)}</div>}</section>
      <aside className="workspace-card"><SectionHeading title="Run contract" description="Immutable identifiers and cohort context." /><DefinitionList items={[{ term: "Run ID", detail: <code>{run.id}</code> }, { term: "State", detail: <StatusChip tone={run.status === "succeeded" ? "positive" : run.status === "failed" ? "critical" : "warning"}>{run.status}</StatusChip> }, { term: "Requested captures", detail: run.requested_capture_count }, { term: "Observation records", detail: observed }, { term: "Recorded coverage", detail: coverage === null ? "Not calculated" : `${Math.min(100, coverage).toFixed(0)}%` }, { term: "Estimated maximum cost", detail: run.estimated_max_cost_usd === null ? "Not recorded" : `$${Number(run.estimated_max_cost_usd).toFixed(2)}` }, { term: "Created", detail: new Date(run.created_at).toLocaleString() }, ...(run.cancelled_at ? [{ term: "Cancelled", detail: new Date(run.cancelled_at).toLocaleString() }, { term: "Cancellation reason", detail: run.cancellation_reason ?? "Not recorded" }] : [])]} />
        {cancellable && writable ? <><SectionHeading title="Cancel run" description="Cancellation is durable and prevents outstanding capture jobs from starting." /><form action={cancelRunAction} className="product-form"><input type="hidden" name="runId" value={run.id} /><div className="field field-wide"><label htmlFor="cancellation-reason">Reason</label><textarea id="cancellation-reason" name="reason" minLength={3} maxLength={500} rows={3} required /></div><div className="form-footer"><p>Completed observations remain available. Cancellation cannot be undone.</p><SubmitButton className="button button-danger button-small" pendingLabel="Cancelling…">Cancel run</SubmitButton></div></form></> : null}
        {cancellable && !writable ? <Notice title="Read-only access" tone="warning"><p>Your {ctx.actor.role} role cannot cancel monitoring runs.</p></Notice> : null}
      </aside>
    </div>
    <p className="workspace-footnote">Recorded coverage counts durable observation outcomes, including failed and unavailable captures; answer-based rates use successful observations only.</p>
  </>;
}
