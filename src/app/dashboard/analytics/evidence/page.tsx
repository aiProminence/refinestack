import Link from "next/link";
import { EmptyState, Notice, PageHeader, SectionHeading, StatCard, StatusChip } from "@/components/product-ui";
import { getIntelligenceAnalytics, listEvidence, listProjects } from "@/lib/db";
import { getDashboardContext } from "../../_context";

export const metadata = { title: "Evidence analytics" };
const percent = (value: number | null) => value === null ? "Not calculated" : `${(value * 100).toFixed(1)}%`;

export default async function EvidenceAnalyticsPage() {
  const ctx = await getDashboardContext();
  const projects = await listProjects(ctx);
  const project = projects[0];
  if (!project) return <><PageHeader eyebrow="Evidence analytics" title="Understand what AI trusts." description="Create a project before analyzing evidence." /><EmptyState title="No project" description="Evidence analytics requires a tenant-scoped project." actionHref="/dashboard/setup" actionLabel="Create project" /></>;
  const [analytics, sources] = await Promise.all([getIntelligenceAnalytics(ctx, project.id), listEvidence(ctx, project.id)]);
  const owned = analytics.metrics.owned_citation_rate;
  const support = analytics.metrics.evidence_support_rate;
  const restricted = sources.filter((source) => !source.retrieval_allowed || !source.quoting_allowed || !source.export_allowed).length;
  return <>
    <PageHeader eyebrow="Evidence analytics" title="Understand what AI trusts." description="Separate owned citations from third-party domains and trace every domain count to its latest source run." actions={<Link className="button button-secondary button-small" href="/dashboard/evidence">Evidence library</Link>} />
    {analytics.limitations.filter((item) => item.severity !== "info").map((item) => <Notice key={item.code} title={item.severity === "blocking" ? "Cohort is not comparable" : "Evidence warning"} tone={item.severity === "blocking" ? "critical" : "warning"}><p>{item.message}</p></Notice>)}
    <section className="stat-grid stat-grid-three"><StatCard label="Owned citation rate" value={percent(owned.value)} detail={`${owned.numerator} / ${owned.denominator} successful captures`} tone="accent" /><StatCard label="Evidence support rate" value={percent(support.value)} detail={`${support.numerator} / ${support.denominator} eligible classified observations`} /><StatCard label="Managed sources" value={String(sources.length)} detail={`${restricted} with at least one restricted policy`} /></section>
    <div className="workspace-two-column workspace-section-spaced"><section className="workspace-card workspace-card-large"><SectionHeading title="Citation domains" description="Exact normalized hostnames returned by provider captures." />{analytics.citationDomains.length ? <div className="table-wrap"><table><caption>Citation domains in the selected project history</caption><thead><tr><th scope="col">Domain</th><th scope="col">Ownership</th><th scope="col">Citations</th><th scope="col">Observations</th><th scope="col">Latest lineage</th></tr></thead><tbody>{analytics.citationDomains.map((domain) => <tr key={domain.domain}><td>{domain.domain}</td><td><StatusChip tone={domain.owned ? "positive" : "neutral"}>{domain.owned ? "Owned" : "Third party"}</StatusChip></td><td>{domain.citations}</td><td>{domain.observations}</td><td>{domain.latestRunId ? <Link className="text-link" href={`/dashboard/runs/${domain.latestRunId}`}>Open run</Link> : "Unavailable"}<br /><small>{new Date(domain.latestCapturedAt).toLocaleString()}</small></td></tr>)}</tbody></table></div> : <EmptyState title="No citation domains" description="A domain appears only when returned by a real successful provider capture." />}</section><aside className="workspace-card"><SectionHeading title="Evidence contract" description="Managed sources and observed citations remain distinct." /><p><strong>{sources.length}</strong> managed sources can ground internal work.</p><p><strong>{analytics.citationDomains.length}</strong> domains were observed in provider citations.</p><p className="workspace-footnote">{analytics.limitations.find((item) => item.code === "evidence_support_definition")?.message}</p></aside></div>
  </>;
}
