import Link from "next/link";
import { EmptyState, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { listObservations, listProjects } from "@/lib/db";
import { getDashboardContext } from "../_context";

export const metadata = { title: "Live answers" };

export default async function AnswersPage() {
  const ctx = await getDashboardContext();
  const projects = await listProjects(ctx);
  const project = projects[0];
  const observations = project ? await listObservations(ctx, { projectId: project.id }) : [];
  const counts = observations.reduce<Record<string, number>>((result, observation) => ({ ...result, [observation.status]: (result[observation.status] ?? 0) + 1 }), {});
  return <>
    <PageHeader eyebrow="Live answers" title="Read what the models actually said." description="Inspect raw answers, provider access method, model or surface, capture time and failure detail." />
    {!project ? <Notice title="Create a project first" tone="warning"><p><Link className="text-link" href="/dashboard/setup">Complete setup</Link> before monitoring answers.</p></Notice> : null}
    <section className="workspace-card"><SectionHeading title="Observation ledger" description={`${counts.succeeded ?? 0} successful · ${counts.failed ?? 0} failed · ${counts.unavailable ?? 0} unavailable`} />
      {!observations.length ? <EmptyState title="No provider answers yet" description="RefineStack does not generate samples. Complete a real monitoring run to populate this ledger." actionHref="/dashboard/runs/new" actionLabel="Open run preflight" /> : <div className="record-stack">{observations.map((observation) => <details className="record-card" key={observation.id}><summary><span><strong>{observation.provider} · {observation.model_or_surface ?? "Surface not recorded"}</strong><small>{observation.access_method} · {new Date(observation.captured_at).toLocaleString()}</small></span><StatusChip tone={observation.status === "succeeded" ? "positive" : observation.status === "failed" ? "critical" : "warning"}>{observation.status}</StatusChip></summary><div className="record-body">{observation.answer_text ? <p className="answer-text">{observation.answer_text}</p> : <Notice title={observation.error_code ?? "No answer captured"} tone="warning"><p>{observation.error_message ?? "No provider response detail was stored."}</p></Notice>}<Link className="text-link" href={`/dashboard/runs/${observation.run_id}`}>Open source run</Link></div></details>)}</div>}
    </section>
  </>;
}
