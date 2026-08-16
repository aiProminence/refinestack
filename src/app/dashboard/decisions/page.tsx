import Link from "next/link";
import { EmptyState, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { getIntelligenceAnalytics, listProjects, type DecisionOutcome } from "@/lib/db";
import { getDashboardContext } from "../_context";

export const metadata = { title: "Decision map" };
const laneContract: Array<{ outcome: DecisionOutcome["outcome"]; title: string; detail: string; tone: "positive" | "critical" | "neutral" | "warning" }> = [
  { outcome: "won", title: "Won", detail: "The primary brand is recommended or ranked first.", tone: "positive" },
  { outcome: "lost", title: "Lost", detail: "A tracked competitor is preferred.", tone: "critical" },
  { outcome: "absent", title: "Absent", detail: "No tracked brand preference appears.", tone: "neutral" },
  { outcome: "unstable", title: "Unstable", detail: "Eligible captures disagree inside the cohort.", tone: "warning" },
];

export default async function DecisionsPage() {
  const ctx = await getDashboardContext();
  const projects = await listProjects(ctx);
  const project = projects[0];
  if (!project) return <><PageHeader eyebrow="Decision map" title="See where the buyer is being directed." description="Create a project before mapping decisions." /><EmptyState title="No project" description="Decision outcomes require tenant-scoped observations." actionHref="/dashboard/setup" actionLabel="Create project" /></>;
  const analytics = await getIntelligenceAnalytics(ctx, project.id);
  return <>
    <PageHeader eyebrow="Decision map" title="See where the buyer is being directed." description="Each lane groups repeated successful observations by question, then uses eligible reviewed brand facts to assign won, lost, absent or unstable." />
    {analytics.limitations.filter((item) => item.severity === "blocking").map((item) => <Notice title="Cohort is not comparable" tone="critical" key={item.code}><p>{item.message}</p></Notice>)}
    {!analytics.records.length ? <Notice title="No captured cohort" tone="info"><p><Link className="text-link" href="/dashboard/runs/new">Prepare a monitoring run</Link> to observe real decision outcomes.</p></Notice> : null}
    <section className="decision-lanes" aria-label="Decision outcome lanes">{laneContract.map((lane) => {
      const decisions = analytics.decisions.filter((decision) => decision.outcome === lane.outcome);
      return <section className="decision-lane" key={lane.outcome}><div><h2>{lane.title}</h2><StatusChip tone={lane.tone}>{decisions.length} decision{decisions.length === 1 ? "" : "s"}</StatusChip></div><p>{lane.detail}</p>{decisions.length ? <div className="record-stack">{decisions.map((decision) => <article className="record-card open" key={decision.questionId}><div className="record-body"><h3>{decision.prompt}</h3><p>{decision.rationale}</p><small>{decision.eligibleCaptures} eligible / {decision.successfulCaptures} successful captures · {decision.market ?? "market not recorded"} · {decision.locale ?? "locale not recorded"}</small><Link className="text-link" href={`/dashboard/runs/${decision.latestRunId}`}>Open latest source run</Link></div></article>)}</div> : <div className="decision-lane-empty">No decisions in this lane</div>}</section>;
    })}</section>
    <section className="workspace-card workspace-section-spaced"><SectionHeading title="Decision lineage" description="Outcome assignment never reads prose heuristically in the UI." /><ol className="lineage-flow"><li><span>01</span>Immutable question</li><li><span>02</span>Successful observations</li><li><span>03</span>Eligible brand facts</li><li><span>04</span>Cross-capture state</li><li><span>05</span>Source run</li></ol></section>
  </>;
}
