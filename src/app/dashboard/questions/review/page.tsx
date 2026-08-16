import Link from "next/link";
import { EmptyState, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { SubmitButton } from "@/components/submit-button";
import { listPendingClassificationReviews, listProjects } from "@/lib/db";
import { submitReviewAction } from "../../_actions";
import { canWrite, getDashboardContext } from "../../_context";

export const metadata = { title: "Review queue" };

export default async function ReviewQueuePage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const [ctx, query] = await Promise.all([getDashboardContext(), searchParams]);
  const projects = await listProjects(ctx);
  const project = projects[0];
  const reviews = project ? await listPendingClassificationReviews(ctx, project.id) : [];
  const writable = canWrite(ctx.actor.role);
  return <>
    <PageHeader eyebrow="Human review" title="Keep uncertain judgments out of headline metrics." description="Inspect source answers and independent classification facts, then record an approved or overridden decision with a reason." />
    {query.saved ? <Notice title="Saved" tone="info"><p>{query.saved}</p></Notice> : null}
    {query.error ? <Notice title="Review was not submitted" tone="critical"><p>{query.error}</p></Notice> : null}
    {!writable ? <Notice title="Read-only access" tone="warning"><p>Your {ctx.actor.role} role can inspect but cannot submit reviews.</p></Notice> : null}
    <section className="workspace-card"><SectionHeading title="Pending classifications" description={`${reviews.length} item${reviews.length === 1 ? "" : "s"} awaiting review`} />
      {!reviews.length ? <EmptyState title="No pending classification reviews" description="The repository returned an empty pending queue. New low-confidence classifications will appear after real captures." actionHref="/dashboard/runs" actionLabel="View monitoring runs" secondary={<Link className="text-link" href="/dashboard/questions">Return to questions</Link>} /> : <div className="record-stack">{reviews.map((review) => <article className="record-card open" key={review.classificationId}><div className="record-summary"><span><strong>{review.observation.provider} · {review.observation.modelOrSurface ?? "surface not recorded"}</strong><small>{review.observation.accessMethod} · captured {new Date(review.observation.capturedAt).toLocaleString()}</small></span><StatusChip tone={review.confidence < 0.5 ? "critical" : "warning"}>{Math.round(review.confidence * 100)}% confidence</StatusChip></div><div className="record-body"><blockquote className="answer-text">{review.observation.answerText ?? "No answer text was stored."}</blockquote><p><strong>Automated rationale:</strong> {review.rationale}</p><dl className="compact-definitions">{Object.entries(review.facts).map(([fact, value]) => <div key={fact}><dt>{fact.replaceAll(/([A-Z])/g, " $1").replaceAll("_", " ")}</dt><dd>{value === null ? "None" : String(value)}</dd></div>)}</dl>
        {writable && project ? <form action={submitReviewAction} className="product-form"><input type="hidden" name="projectId" value={project.id} /><input type="hidden" name="classificationId" value={review.classificationId} /><div className="form-grid"><div className="field"><label htmlFor={`decision-${review.classificationId}`}>Decision</label><select id={`decision-${review.classificationId}`} name="decision"><option value="approved">Approve stored facts</option><option value="overridden">Override facts below</option></select></div><div className="field"><label htmlFor={`rank-${review.classificationId}`}>Override rank</label><input id={`rank-${review.classificationId}`} name="rank" type="number" min={1} defaultValue={review.facts.rank ?? ""} /></div><fieldset className="policy-checks field-wide"><legend>Override facts</legend>{[["mentioned", review.facts.mentioned], ["cited", review.facts.cited], ["shortlisted", review.facts.shortlisted], ["explicitlyRecommended", review.facts.explicitlyRecommended], ["firstChoice", review.facts.firstChoice], ["rejected", review.facts.rejected]].map(([name, checked]) => <label key={String(name)}><input type="checkbox" name={String(name)} defaultChecked={Boolean(checked)} /> {String(name).replaceAll(/([A-Z])/g, " $1")}</label>)}</fieldset><div className="field field-wide"><label htmlFor={`reason-${review.classificationId}`}>Review reason</label><textarea id={`reason-${review.classificationId}`} name="reason" rows={3} required minLength={8} /></div></div><SubmitButton pendingLabel="Submitting…">Submit review</SubmitButton></form> : null}
      </div></article>)}</div>}
    </section>
  </>;
}
