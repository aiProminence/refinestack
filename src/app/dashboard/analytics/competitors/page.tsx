import Link from "next/link";
import { EmptyState, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { getIntelligenceAnalytics, listProjects } from "@/lib/db";
import { getDashboardContext } from "../../_context";

export const metadata = { title: "Competitor analytics" };
const rate = (numerator: number, denominator: number) => denominator ? `${(numerator / denominator * 100).toFixed(1)}%` : "Not calculated";

export default async function CompetitorAnalyticsPage() {
  const ctx = await getDashboardContext();
  const projects = await listProjects(ctx);
  const project = projects[0];
  if (!project) return <><PageHeader eyebrow="Competitor analytics" title="Know who gets recommended instead." description="Create a project and competitor cohort first." /><EmptyState title="No project" description="Competitor analytics requires tracked brands." actionHref="/dashboard/setup" actionLabel="Create project" /></>;
  const analytics = await getIntelligenceAnalytics(ctx, project.id);
  const competitors = analytics.brands.filter((brand) => brand.role === "competitor");
  return <>
    <PageHeader eyebrow="Competitor analytics" title="Know who gets recommended instead." description="Compare tracked brands across the same observation cohort. Rates use only eligible reviewed classifications for each brand." actions={<Link className="button button-secondary button-small" href="/dashboard/analytics">All metrics</Link>} />
    {analytics.limitations.filter((item) => item.severity === "blocking").map((item) => <Notice key={item.code} title="Comparison blocked" tone="critical"><p>{item.message}</p></Notice>)}
    <section className="workspace-card"><SectionHeading title="Competitive position" description={`${analytics.records.length} observations · ${analytics.cohort.questionSetIds.length} immutable question set${analytics.cohort.questionSetIds.length === 1 ? "" : "s"}`} />{!competitors.length ? <EmptyState title="No competitors to compare" description="Define at least one tracked competitor; RefineStack does not infer a leaderboard." actionHref="/dashboard/setup" actionLabel="Define competitors" /> : <div className="table-wrap"><table><caption>Same-cohort tracked brand facts</caption><thead><tr><th scope="col">Brand</th><th scope="col">Eligible captures</th><th scope="col">Mention rate</th><th scope="col">Recommendation rate</th><th scope="col">First-choice rate</th></tr></thead><tbody>{analytics.brands.map((brand) => <tr key={brand.brandId}><td><strong>{brand.name}</strong><br /><small>{brand.domain}</small><br /><StatusChip tone={brand.role === "primary" ? "positive" : "neutral"}>{brand.role}</StatusChip></td><td>{brand.eligibleCaptures}</td><td>{rate(brand.mentions, brand.eligibleCaptures)}<br /><small>{brand.mentions} / {brand.eligibleCaptures}</small></td><td>{rate(brand.recommendations, brand.eligibleCaptures)}<br /><small>{brand.recommendations} / {brand.eligibleCaptures}</small></td><td>{rate(brand.firstChoices, brand.eligibleCaptures)}<br /><small>{brand.firstChoices} / {brand.eligibleCaptures}</small></td></tr>)}</tbody></table></div>}</section>
    <section className="workspace-card workspace-section-spaced"><SectionHeading title="Comparison safeguards" description="These dimensions must remain explicit when interpreting movement." /><ul className="safeguard-list"><li>Question set: {analytics.cohort.questionSetIds.join(", ") || "not recorded"}</li><li>Providers: {analytics.cohort.providers.join(", ") || "none"}</li><li>Models: {analytics.cohort.models.join(", ") || "none"}</li><li>Markets: {analytics.cohort.markets.join(", ") || "none"}</li><li>Classifier versions: {analytics.cohort.classifierVersions.join(", ") || "none"}</li></ul></section>
  </>;
}
