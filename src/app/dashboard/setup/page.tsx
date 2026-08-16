import Link from "next/link";
import { Notice, PageHeader, ProgressMeter, SectionHeading, StatusChip } from "@/components/product-ui";
import { SubmitButton } from "@/components/submit-button";
import { listBrands, listProjects } from "@/lib/db";
import { saveBrandAction, saveProjectAction } from "../_actions";
import { canWrite, getDashboardContext } from "../_context";

export const metadata = { title: "Project setup" };

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const [ctx, query] = await Promise.all([getDashboardContext(), searchParams]);
  const projects = await listProjects(ctx);
  const project = projects[0];
  const brands = project ? await listBrands(ctx, project.id) : [];
  const writable = canWrite(ctx.actor.role);
  const readiness = project ? [project.name, project.domain, project.category, project.default_market, project.default_locale, project.languages.length ? "language" : null].filter(Boolean).length / 6 * 100 : 0;

  return <>
    <PageHeader eyebrow="Guided setup" title="Define the market before measuring it." description="A precise project definition keeps questions, entity matching and competitor comparisons grounded in the same buyer decision space." />
    {query.saved ? <Notice title="Saved" tone="info"><p>{query.saved}</p></Notice> : null}
    {query.error ? <Notice title="Project was not saved" tone="critical"><p>{query.error}</p></Notice> : null}
    {!writable ? <Notice title="Read-only access" tone="warning"><p>Your {ctx.actor.role} role can inspect setup but cannot change it.</p></Notice> : null}
    <div className="setup-layout">
      <aside className="setup-steps" aria-label="Project setup progress"><ProgressMeter label="Project readiness" value={Math.round(readiness)} description="Project fields saved in the current workspace." /><ol><li className="current"><span>01</span><div><strong>Project</strong><small>Identity, domain and category</small></div></li><li><span>02</span><div><strong>Market</strong><small>Region, locale and languages</small></div></li><li><span>03</span><div><strong>Brands</strong><small>Primary brand and competitors</small></div></li><li><span>04</span><div><strong>Questions</strong><small>Buyer decisions and coverage</small></div></li></ol></aside>
      <section className="workspace-card setup-form-card">
        <SectionHeading title={project ? "Project foundation" : "Create the first project"} description="These values are persisted through the workspace-scoped repository." />
        <form className="product-form" action={saveProjectAction}>
          <fieldset disabled={!writable}>{project ? <input type="hidden" name="projectId" value={project.id} /> : null}<div className="form-grid">
            <div className="field"><label htmlFor="project-name">Project name</label><input id="project-name" name="projectName" defaultValue={project?.name} required maxLength={120} /></div>
            <div className="field"><label htmlFor="domain">Primary domain</label><input id="domain" name="domain" type="url" inputMode="url" defaultValue={project?.domain ?? ""} placeholder="https://example.com" /></div>
            <div className="field field-wide"><label htmlFor="category">Buyer-facing category</label><input id="category" name="category" defaultValue={project?.category ?? ""} placeholder="The category buyers use in recommendation questions" /></div>
            <div className="field"><label htmlFor="market">Primary market</label><input id="market" name="market" defaultValue={project?.default_market ?? "Malaysia"} required /></div>
            <div className="field"><label htmlFor="locale">Primary locale</label><input id="locale" name="locale" defaultValue={project?.default_locale ?? "en-MY"} required pattern="[A-Za-z]{2,3}(-[A-Za-z]{2})?" /></div>
            <div className="field field-wide"><label htmlFor="languages">Languages</label><input id="languages" name="languages" defaultValue={project?.languages.join(", ") ?? "English"} required aria-describedby="languages-help" /><small id="languages-help">Comma-separated language names.</small></div>
          </div><div className="form-footer"><p>Saving creates or updates only this workspace&apos;s project.</p><SubmitButton pendingLabel="Saving…">{project ? "Save changes" : "Create project"}</SubmitButton></div></fieldset>
        </form>
      </section>
    </div>
    {project ? <section className="workspace-card workspace-section-spaced"><SectionHeading title="Tracked brands" description="Define one primary brand and the competitors included in this measurement cohort." />
      {writable ? <form action={saveBrandAction} className="product-form"><input type="hidden" name="projectId" value={project.id} /><div className="form-grid"><div className="field"><label htmlFor="brand-role">Role</label><select id="brand-role" name="role"><option value="primary">Primary brand</option><option value="competitor">Competitor</option></select></div><div className="field"><label htmlFor="brand-name">Brand name</label><input id="brand-name" name="name" required /></div><div className="field"><label htmlFor="brand-domain">Domain</label><input id="brand-domain" name="domain" type="url" placeholder="https://example.com" required /></div><div className="field"><label htmlFor="brand-market">Market</label><input id="brand-market" name="market" defaultValue={project.default_market} required /></div></div><SubmitButton pendingLabel="Adding…">Add brand</SubmitButton></form> : null}
      {brands.length ? <div className="record-stack workspace-section-spaced">{brands.map((brand) => <form action={saveBrandAction} className="record-card open" key={brand.id}><input type="hidden" name="brandId" value={brand.id} /><div className="record-body form-grid"><div className="field"><label htmlFor={`brand-role-${brand.id}`}>Role</label><select id={`brand-role-${brand.id}`} name="role" defaultValue={brand.role} disabled={!writable}><option value="primary">Primary brand</option><option value="competitor">Competitor</option></select></div><div className="field"><label htmlFor={`brand-name-${brand.id}`}>Name</label><input id={`brand-name-${brand.id}`} name="name" defaultValue={brand.name} disabled={!writable} required /></div><div className="field"><label htmlFor={`brand-domain-${brand.id}`}>Domain</label><input id={`brand-domain-${brand.id}`} name="domain" defaultValue={brand.domain} disabled={!writable} required /></div><div className="field"><label htmlFor={`brand-market-${brand.id}`}>Market</label><input id={`brand-market-${brand.id}`} name="market" defaultValue={brand.market} disabled={!writable} required /></div>{writable ? <SubmitButton className="button button-secondary button-small" pendingLabel="Saving…">Save brand</SubmitButton> : null}</div></form>)}</div> : <Notice title="No brands tracked" tone="warning"><p>Add a primary brand and at least one competitor to complete study readiness.</p></Notice>}
    </section> : null}
    <p className="workspace-footnote"><StatusChip tone="info">Data rule</StatusChip> Historical runs retain their stored cohort. <Link href="/dashboard/questions">Continue to questions</Link>.</p>
  </>;
}
