import Link from "next/link";
import { EmptyState, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { getIntelligenceAnalytics, getProductSnapshot, listProjects } from "@/lib/db";
import { getDashboardContext } from "./_context";

export const metadata = { title: "AI visibility overview" };

const percent = (value: number | null) => value === null ? "Not measured" : `${(value * 100).toFixed(1)}%`;

export default async function DashboardOverview() {
  const ctx = await getDashboardContext();
  const [snapshot, projects] = await Promise.all([getProductSnapshot(ctx), listProjects(ctx)]);
  const project = projects[0];
  const analytics = project ? await getIntelligenceAnalytics(ctx, project.id) : null;
  const healthyProvider = snapshot.providers.some((provider) => provider.enabled && provider.state === "healthy");
  const baseline = snapshot.recentRuns.some((run) => run.status === "succeeded" || run.status === "partial");
  const readiness = [
    ["Project definition", "Brand, category and markets", !snapshot.setup.missing.includes("project") && !snapshot.setup.missing.includes("category")],
    ["Decision questions", "Typed, reviewed and active", !snapshot.setup.missing.includes("question")],
    ["Provider access", "At least one healthy capture path", healthyProvider],
    ["Baseline run", "Preflight approved and completed", baseline],
  ] as const;

  const outcomeCounts = { won: 0, lost: 0, absent: 0, unstable: 0 };
  for (const decision of analytics?.decisions ?? []) outcomeCounts[decision.outcome] += 1;
  const primary = analytics?.brands.find((brand) => brand.role === "primary");
  const competitors = analytics?.brands.filter((brand) => brand.role === "competitor").slice(0, 4) ?? [];
  const metricCards = analytics ? [
    ["AI Recommendation Share", analytics.metrics.recommendation_share, "Your share of all explicit brand recommendations."],
    ["Visibility Rate", analytics.metrics.mention_rate, "How often your brand appears in eligible AI answers."],
    ["First-choice Rate", analytics.metrics.first_choice_rate, "How often AI names your brand as the first choice."],
    ["Evidence Strength", analytics.metrics.evidence_support_rate, "Eligible answers supported by captured evidence."],
  ] as const : [];

  return <>
    <PageHeader eyebrow="AI visibility overview" title="Become prominent where AI shapes the shortlist." description="See how often AI surfaces mention, recommend and prefer your brand, then trace every result back to the answer and evidence that produced it." actions={<div className="page-actions"><Link className="button button-secondary button-small" href="/dashboard/analytics">Explore analytics</Link><Link className="button button-small" href="/dashboard/runs">Run monitoring</Link></div>} />
    {!snapshot.setup.complete ? <Notice title="Study setup is incomplete" tone="info"><p>Missing: {snapshot.setup.missing.join(", ").replaceAll("_", " ")}. Complete setup before interpreting a baseline.</p></Notice> : null}
    {analytics ? <section className="visibility-scorecard" aria-label="AI visibility scorecard">{metricCards.map(([label, metric, detail], index) => <article className={index === 0 ? "visibility-metric visibility-metric-primary" : "visibility-metric"} key={label}><span>{label}</span><strong>{percent(metric.value)}</strong><p>{metric.denominator ? `${metric.numerator} of ${metric.denominator}. ${detail}` : detail}</p></article>)}</section> : <EmptyState eyebrow="AI visibility" title="Create a project to establish your baseline" description="Define your brand, competitors and decision prompts before Refinestack captures the AI answers that shape your category." actionHref="/dashboard/setup" actionLabel="Set up your project" />}
    {analytics ? <div className="workspace-two-column prominence-overview">
      <section className="workspace-card workspace-card-large">
        <SectionHeading title="Decision map" description="The latest evidence-backed outcome for each tracked buyer question." action={<Link className="text-link" href="/dashboard/decisions">Open decision map</Link>} />
        {analytics.decisions.length ? <div className="decision-distribution" aria-label={`${analytics.decisions.length} tracked decisions`}>
          {(["won", "lost", "absent", "unstable"] as const).map((outcome) => { const count = outcomeCounts[outcome]; const width = analytics.decisions.length ? Math.max(4, count / analytics.decisions.length * 100) : 0; return <div key={outcome}><div><strong>{outcome}</strong><span>{count}</span></div><span className={`decision-bar decision-bar-${outcome}`}><i style={{ width: `${width}%` }} /></span></div>; })}
        </div> : <EmptyState title="No classified decisions yet" description="Complete a monitoring run to see where your brand is won, lost, absent or unstable." actionHref="/dashboard/runs" actionLabel="Start monitoring" />}
      </section>
      <section className="workspace-card">
        <SectionHeading title="Study pulse" description="The quality and operating state behind this view." />
        <div className="prominence-pulse">
          <div><span>Successful observations</span><strong>{analytics.records.filter((record) => record.status === "succeeded").length}</strong></div>
          <div><span>Tracked prompts</span><strong>{snapshot.counts.questions}</strong></div>
          <div><span>Pending reviews</span><strong>{snapshot.pendingReviewCount}</strong></div>
          <div><span>Action queue</span><strong>{snapshot.counts.actions}</strong></div>
        </div>
        <p className="workspace-footnote"><StatusChip tone={healthyProvider ? "positive" : "warning"}>{healthyProvider ? "Capture path healthy" : "Provider attention needed"}</StatusChip> Failed captures remain visible and never inflate metrics.</p>
      </section>
    </div> : null}
    {analytics ? <div className="workspace-two-column workspace-section-spaced prominence-overview">
      <section className="workspace-card">
        <SectionHeading title="Competitive position" description="Same-cohort facts for your brand and tracked competitors." action={<Link className="text-link" href="/dashboard/analytics/competitors">Full comparison</Link>} />
        {primary || competitors.length ? <div className="competitor-stack">{[...(primary ? [primary] : []), ...competitors].map((brand) => { const rate = brand.eligibleCaptures ? brand.recommendations / brand.eligibleCaptures : null; return <div key={brand.brandId}><span><strong>{brand.name}</strong><small>{brand.role === "primary" ? "Your brand" : "Competitor"}</small></span><span className="competitor-meter"><i style={{ width: `${rate === null ? 0 : rate * 100}%` }} /></span><b>{percent(rate)}</b></div>; })}</div> : <EmptyState title="No competitor observations yet" description="Track at least one competitor and complete a run to compare recommendation rates." actionHref="/dashboard/setup" actionLabel="Define competitors" />}
      </section>
      <section className="workspace-card">
        <SectionHeading title="Latest signals" description="Recent buyer questions with a classified outcome." action={<Link className="text-link" href="/dashboard/answers">View answers</Link>} />
        {analytics.decisions.length ? <ol className="signal-list">{analytics.decisions.slice(0, 4).map((decision) => <li key={decision.questionId}><StatusChip tone={decision.outcome === "won" ? "positive" : decision.outcome === "lost" ? "critical" : "warning"}>{decision.outcome}</StatusChip><span><strong>{decision.prompt}</strong><small>{new Date(decision.latestCapturedAt).toLocaleDateString()} · {decision.eligibleCaptures} eligible capture{decision.eligibleCaptures === 1 ? "" : "s"}</small></span></li>)}</ol> : <p className="workspace-footnote">Signals appear after eligible answers are classified.</p>}
      </section>
    </div> : null}
    <div className="workspace-two-column">
      {!baseline ? <section className="workspace-card workspace-section-spaced">
        <SectionHeading title="Study readiness" description="Required foundations for a valid baseline." />
        <ol className="readiness-list">{readiness.map(([title, detail, ready]) => <li key={title}><StatusChip tone={ready ? "positive" : "warning"}>{ready ? "Ready" : "Waiting"}</StatusChip><span><strong>{title}</strong><small>{detail}</small></span></li>)}</ol>
      </section> : null}
    </div>
    <section className="workspace-card workspace-section-spaced">
      <SectionHeading title="Recent monitoring" description="Every requested capture remains visible, including failures and unavailable providers." action={<Link className="text-link" href="/dashboard/runs">View all runs</Link>} />
      {snapshot.recentRuns.length ? <div className="table-wrap"><table><caption>Five most recent runs</caption><thead><tr><th scope="col">Created</th><th scope="col">State</th><th scope="col">Requested</th><th scope="col">Details</th></tr></thead><tbody>{snapshot.recentRuns.map((run) => <tr key={run.id}><td>{new Date(run.createdAt).toLocaleString()}</td><td><StatusChip tone={run.status === "succeeded" ? "positive" : run.status === "failed" ? "critical" : "warning"}>{run.status}</StatusChip></td><td>{run.requestedCaptureCount}</td><td><Link className="text-link" href={`/dashboard/runs/${run.id}`}>Open run</Link></td></tr>)}</tbody></table></div> : <EmptyState title="No monitoring runs yet" description="A run can start only after a project has active questions and at least one configured provider passes preflight." actionHref="/dashboard/setup" actionLabel="Start with project setup" />}
    </section>
  </>;
}
