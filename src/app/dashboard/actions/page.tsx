import Link from "next/link";
import { BidiText, EmptyState, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { SubmitButton } from "@/components/submit-button";
import { listProjects } from "@/lib/db";
import { listActionLineageWorkspace, type ActionReferenceKind } from "@/lib/db/action-lineage";
import { canWrite, getDashboardContext } from "../_context";
import { createEvidenceLinkedAction, transitionEvidenceLinkedAction } from "./actions";

export const metadata = { title: "Action backlog" };

const referenceHeadings: Record<ActionReferenceKind, string> = {
  question_version: "Question versions",
  classification: "Observed classifications",
  source_version: "Evidence source versions",
};

export default async function ActionsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const [ctx, query] = await Promise.all([getDashboardContext(), searchParams]);
  const projects = await listProjects(ctx);
  const project = projects[0];
  const workspace = project ? await listActionLineageWorkspace(ctx, project.id) : null;
  const actions = workspace?.actions ?? [];
  const references = workspace?.references ?? [];
  const writable = canWrite(ctx.actor.role);
  const counts = actions.reduce<Record<string, number>>((result, action) => ({
    ...result, [action.status]: (result[action.status] ?? 0) + 1,
  }), {});

  return <>
    <PageHeader eyebrow="Action backlog" title="Turn observed gaps into accountable work." description="Every action starts from an immutable record. Follow-up runs record what happened later; they do not prove the action caused the result." />
    {query.saved ? <Notice title="Saved" tone="info"><p>{query.saved}</p></Notice> : null}
    {query.error ? <Notice title="Action change failed" tone="critical"><p>{query.error}</p></Notice> : null}
    {!project ? <Notice title="Create a project first" tone="warning"><p><Link className="text-link" href="/dashboard/setup">Project setup</Link> is required before creating actions.</p></Notice> : null}
    {project && writable && !references.length ? <Notice title="No immutable starting record" tone="warning"><p>Capture a monitoring run or add a versioned evidence source before proposing an action. RefineStack will not create an ungrounded recommendation.</p></Notice> : null}
    {project && writable && references.length ? <section className="workspace-card">
      <SectionHeading title="Add an evidence-linked action" description="Choose the exact observed record that motivated the work, then explain the bounded rationale." />
      <form className="product-form" action={createEvidenceLinkedAction}>
        <input type="hidden" name="projectId" value={project.id} />
        <div className="form-grid">
          <div className="field field-wide"><label htmlFor="action-title">Action title</label><input id="action-title" name="title" required minLength={3} maxLength={180} /></div>
          <div className="field field-wide"><label htmlFor="action-description">Bounded deliverable</label><textarea id="action-description" name="description" rows={4} required minLength={10} maxLength={4000} /></div>
          <div className="field field-wide"><label htmlFor="action-lineage">Immutable observed record</label><select id="action-lineage" name="lineageTarget" required defaultValue=""><option value="" disabled>Select one exact record</option>{(["question_version", "classification", "source_version"] as const).map((kind) => {
            const options = references.filter((reference) => reference.kind === kind);
            return options.length ? <optgroup key={kind} label={referenceHeadings[kind]}>{options.map((reference) => <option key={reference.value} value={reference.value}>{reference.label}</option>)}</optgroup> : null;
          })}</select></div>
          <div className="field field-wide"><label htmlFor="action-lineage-rationale">Why this record warrants the action</label><textarea id="action-lineage-rationale" name="lineageRationale" rows={3} required minLength={10} maxLength={2000} /></div>
          <div className="field"><label htmlFor="action-impact">Expected impact</label><input id="action-impact" name="expectedImpact" required minLength={3} maxLength={1000} /></div>
          <div className="field"><label htmlFor="action-effort">Effort</label><input id="action-effort" name="effort" required minLength={3} maxLength={1000} /></div>
          <div className="field field-wide"><label htmlFor="action-uncertainty">Uncertainty</label><input id="action-uncertainty" name="uncertainty" required minLength={3} maxLength={1000} /></div>
        </div>
        <SubmitButton pendingLabel="Adding…">Add evidence-linked action</SubmitButton>
      </form>
    </section> : null}
    <section className="workspace-card workspace-section-spaced">
      <SectionHeading title="Backlog" description={`${counts.proposed ?? 0} proposed · ${counts.approved ?? 0} approved · ${counts.in_progress ?? 0} in progress · ${counts.completed ?? 0} completed`} />
      {!actions.length ? <EmptyState title="No actions" description="Actions appear only after an analyst links a specific immutable observation and states the rationale." actionHref="/dashboard/runs/new" actionLabel="Prepare a baseline run" /> : <div className="record-stack">{actions.map((action) => {
        const eligibleRuns = (workspace?.followUpRuns ?? []).filter((run) => new Date(run.createdAt).getTime() > new Date(action.created_at).getTime());
        return <article className="record-card open" key={action.id}>
          <div className="record-summary"><span><strong><BidiText>{action.title}</BidiText></strong><small>Updated {new Date(action.updated_at).toLocaleString()}</small></span><StatusChip tone={action.status === "completed" ? "positive" : action.status === "dismissed" ? "neutral" : "warning"}>{action.status.replaceAll("_", " ")}</StatusChip></div>
          <div className="record-body">
            <p><BidiText>{action.description}</BidiText></p>
            <dl className="compact-definitions"><div><dt>Expected impact</dt><dd><BidiText>{action.expected_impact ?? "Not specified"}</BidiText></dd></div><div><dt>Effort</dt><dd><BidiText>{action.effort ?? "Not specified"}</BidiText></dd></div><div><dt>Uncertainty</dt><dd><BidiText>{action.uncertainty ?? "Not specified"}</BidiText></dd></div></dl>
            <section className="workspace-section-spaced" aria-label="Starting evidence">
              <h3>Immutable starting evidence</h3>
              {action.evidenceLinks.map((link) => <div className="record-card" key={link.id}><strong><BidiText>{link.label}</BidiText></strong><p><BidiText>{link.detail}</BidiText></p><p><strong>Recorded rationale:</strong> <BidiText>{link.rationale}</BidiText></p></div>)}
            </section>
            {action.followUps.length ? <section className="workspace-section-spaced" aria-label="Follow-up outcomes"><h3>Later observed outcomes</h3>{action.followUps.map((followUp) => <div className="record-card" key={followUp.id}><p><Link className="text-link" href={`/dashboard/runs/${encodeURIComponent(followUp.runId)}`}>Monitoring run from {new Date(followUp.runCreatedAt).toLocaleString()}</Link> · {followUp.runStatus}</p><p><BidiText>{followUp.outcomeNote}</BidiText></p><small>This temporal link records a later observation. It does not assert that this action caused the outcome.</small></div>)}</section> : null}
            {writable && action.status !== "completed" ? <form action={transitionEvidenceLinkedAction} className="product-form workspace-section-spaced">
              <input type="hidden" name="projectId" value={action.project_id} />
              <input type="hidden" name="actionId" value={action.id} />
              <div className="form-grid">
                <div className="field"><label htmlFor={`action-status-${action.id}`}>Status</label><select id={`action-status-${action.id}`} name="status" defaultValue={action.status}><option value="proposed">Proposed</option><option value="approved">Approved</option><option value="in_progress">In progress</option><option value="completed" disabled={!eligibleRuns.length}>Completed</option><option value="dismissed">Dismissed</option></select></div>
                <div className="field"><label htmlFor={`follow-up-${action.id}`}>Later monitoring run (required for completion)</label><select id={`follow-up-${action.id}`} name="followUpRunId" defaultValue=""><option value="">No follow-up selected</option>{eligibleRuns.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString()} · {run.status}</option>)}</select></div>
                <div className="field field-wide"><label htmlFor={`outcome-${action.id}`}>Factual outcome note (required for completion)</label><input id={`outcome-${action.id}`} name="outcomeNote" maxLength={2000} aria-describedby={`outcome-help-${action.id}`} /><small id={`outcome-help-${action.id}`}>Describe what the later run observed. Do not claim the action caused the change.</small></div>
              </div>
              <SubmitButton className="button button-secondary button-small" pendingLabel="Updating…">Update action</SubmitButton>
            </form> : null}
          </div>
        </article>;
      })}</div>}
    </section>
  </>;
}
