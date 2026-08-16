import Link from "next/link";
import { EmptyState, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { SubmitButton } from "@/components/submit-button";
import { listProjects, listQuestions } from "@/lib/db";
import { summarizeQuestionCoverage, validateQuestionDraft } from "@/lib/ai/questions";
import { questionTypes } from "@/types/contracts";
import { createQuestionAction, editQuestionAction, updateQuestionStateAction } from "../_actions";
import { canWrite, getDashboardContext } from "../_context";

export const metadata = { title: "Question library" };
const label = (value: string) => value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());

export default async function QuestionsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const [ctx, query] = await Promise.all([getDashboardContext(), searchParams]);
  const projects = await listProjects(ctx);
  const project = projects[0];
  const questions = project ? await listQuestions(ctx, project.id) : [];
  const writable = canWrite(ctx.actor.role);
  const counts = questions.reduce<Record<string, number>>((result, question) => ({ ...result, [question.state]: (result[question.state] ?? 0) + 1 }), {});
  const coverage = summarizeQuestionCoverage(questions.map((question) => ({
    id: question.id,
    state: question.state,
    questionType: question.question_type,
    persona: question.persona ?? "",
    stage: question.stage ?? "",
    market: question.market,
    rationale: question.rationale ?? "",
  })));
  const diagnostics = new Map(questions.map((question) => [question.id, validateQuestionDraft({
    prompt: question.current_prompt,
    questionType: question.question_type,
    persona: question.persona ?? "",
    stage: question.stage ?? "",
    market: question.market,
    locale: question.locale,
    rationale: question.rationale ?? "",
  }, { knownQuestions: questions.filter(({ id }) => id !== question.id).map(({ id, current_prompt }) => ({ id, prompt: current_prompt })) })]));
  const incompleteTotal = Object.values(coverage.incomplete).reduce((sum, count) => sum + count, 0);

  return <>
    <PageHeader eyebrow="Question library" title="Measure decisions, not keywords." description="Build a versioned set of realistic buyer questions, then review answerability and coverage before any provider call." actions={<Link className="button button-secondary button-small" href="/dashboard/questions/review">Review queue</Link>} />
    {query.saved ? <Notice title="Saved" tone="info"><p>{query.saved}</p></Notice> : null}
    {query.error ? <Notice title="Question change failed" tone="critical"><p>{query.error}</p></Notice> : null}
    {!project ? <Notice title="Create a project first" tone="warning"><p><Link className="text-link" href="/dashboard/setup">Project setup</Link> is required before adding questions.</p></Notice> : null}
    {project && writable ? <section className="workspace-card">
      <SectionHeading title="Add a buyer question" description={`New questions are added to ${project.name}.`} />
      <form action={createQuestionAction} className="product-form">
        <input type="hidden" name="projectId" value={project.id} />
        <div className="form-grid">
          <div className="field field-wide"><label htmlFor="question-prompt">Exact buyer question</label><textarea id="question-prompt" name="prompt" rows={3} required minLength={18} maxLength={500} aria-describedby="question-prompt-help" /><small id="question-prompt-help">Use an unbiased decision question. Exact and near duplicates are rejected.</small></div>
          <div className="field"><label htmlFor="question-type">Question type</label><select id="question-type" name="questionType" required>{questionTypes.map((type) => <option key={type} value={type}>{label(type)}</option>)}</select></div>
          <div className="field"><label htmlFor="question-market">Market</label><input id="question-market" name="market" defaultValue={project.default_market} required /></div>
          <div className="field"><label htmlFor="question-locale">Locale</label><input id="question-locale" name="locale" defaultValue={project.default_locale} placeholder="en-US" pattern="[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*" required /></div>
          <div className="field"><label htmlFor="question-persona">Buyer persona</label><input id="question-persona" name="persona" minLength={2} placeholder="IT director" required /></div>
          <div className="field"><label htmlFor="question-stage">Journey stage</label><input id="question-stage" name="stage" minLength={2} placeholder="Shortlisting" required /></div>
          <div className="field field-wide"><label htmlFor="question-rationale">Measurement rationale</label><textarea id="question-rationale" name="rationale" rows={2} minLength={12} placeholder="Measures which integration constraints shape the shortlist." required /></div>
        </div>
        <div className="form-footer"><p>Market and locale are stored independently for reproducible captures.</p><SubmitButton pendingLabel="Adding…">Add question</SubmitButton></div>
      </form>
    </section> : null}
    {project ? <section className="workspace-card workspace-section-spaced">
      <SectionHeading title="Question coverage" description="Coverage uses active questions only. Playbook targets are the 14 supported types; persona, stage and market gaps use the values currently defined in this active library." />
      <div className="quality-grid" aria-label="Question coverage summary">
        <article><StatusChip tone={coverage.missingTypes.length ? "warning" : "positive"}>Question types</StatusChip><h3>{questionTypes.length - coverage.missingTypes.length} / {questionTypes.length}</h3><p>Supported playbook types represented by active questions.</p></article>
        <article><StatusChip tone={coverage.personas.length ? "info" : "critical"}>Personas</StatusChip><h3>{coverage.personas.length}</h3><p>{coverage.personas.join(", ") || "No active persona coverage."}</p></article>
        <article><StatusChip tone={coverage.stages.length ? "info" : "critical"}>Stages</StatusChip><h3>{coverage.stages.length}</h3><p>{coverage.stages.join(", ") || "No active journey-stage coverage."}</p></article>
        <article><StatusChip tone={coverage.markets.length ? "info" : "critical"}>Markets</StatusChip><h3>{coverage.markets.length}</h3><p>{coverage.markets.join(", ") || "No active market coverage."}</p></article>
      </div>
      {incompleteTotal ? <Notice title="Active metadata gaps" tone="critical"><p>{coverage.incomplete.persona} persona · {coverage.incomplete.stage} stage · {coverage.incomplete.market} market · {coverage.incomplete.rationale} rationale fields need repair before those questions can be restored or edited.</p></Notice> : null}
      {coverage.missingTypes.length ? <Notice title="Missing playbook types" tone="warning"><p>{coverage.missingTypes.map(label).join(", ")}</p></Notice> : null}
      {coverage.missingCombinations.length ? <Notice title="Uncovered buyer contexts" tone="warning"><p>{coverage.missingCombinations.slice(0, 12).map(({ persona, stage, market }) => `${persona} / ${stage} / ${market}`).join("; ")}{coverage.missingCombinations.length > 12 ? `; and ${coverage.missingCombinations.length - 12} more.` : "."}</p></Notice> : null}
      <div className="table-wrap"><table>
        <caption>Active-question coverage by playbook type and buyer context</caption>
        <thead><tr><th scope="col">Question type</th><th scope="col">Active</th><th scope="col">Personas</th><th scope="col">Stages</th><th scope="col">Markets</th></tr></thead>
        <tbody>{coverage.rows.map((row) => <tr key={row.questionType}><th scope="row">{label(row.questionType)}</th><td>{row.total}</td><td>{row.personas.join(", ") || "Gap"}</td><td>{row.stages.join(", ") || "Gap"}</td><td>{row.markets.join(", ") || "Gap"}</td></tr>)}</tbody>
      </table></div>
    </section> : null}
    <section className="workspace-card workspace-section-spaced">
      <SectionHeading title="Project questions" description={`${questions.length} total · ${counts.active ?? 0} active · ${counts.disqualified ?? 0} disqualified · ${counts.archived ?? 0} archived`} />
      {!questions.length ? <EmptyState title="No questions in this project" description="Add a real buyer decision question after completing project setup." actionHref="/dashboard/setup" actionLabel="Complete setup" /> : <div className="record-stack">{questions.map((question) => <details className="record-card" key={question.id}>
        <summary><span><strong>{question.current_prompt}</strong><small>{label(question.question_type)} · {question.market} · {question.locale} · version {question.current_version}</small></span><StatusChip tone={question.state === "active" ? "positive" : question.state === "disqualified" ? "critical" : "neutral"}>{question.state}</StatusChip></summary>
        <div className="record-body">
          {(diagnostics.get(question.id)?.issues.length ?? 0) > 0 ? <Notice title="Quality issues" tone="warning"><ul>{diagnostics.get(question.id)!.issues.map((issue) => <li key={`${issue.field}-${issue.code}`}>{issue.message}</li>)}</ul></Notice> : <p><StatusChip tone="positive">Quality ready</StatusChip> Required metadata is complete and no duplicate was detected.</p>}
          {writable ? <form action={editQuestionAction} className="product-form">
            <input type="hidden" name="questionId" value={question.id} />
            <input type="hidden" name="projectId" value={project?.id ?? ""} />
            <div className="form-grid">
              <div className="field field-wide"><label htmlFor={`prompt-${question.id}`}>Question</label><textarea id={`prompt-${question.id}`} name="prompt" defaultValue={question.current_prompt} rows={3} minLength={18} maxLength={500} required /></div>
              <div className="field"><label htmlFor={`type-${question.id}`}>Type</label><select id={`type-${question.id}`} name="questionType" defaultValue={question.question_type} required>{questionTypes.map((type) => <option key={type} value={type}>{label(type)}</option>)}</select></div>
              <div className="field"><label htmlFor={`market-${question.id}`}>Market</label><input id={`market-${question.id}`} name="market" defaultValue={question.market} required /></div>
              <div className="field"><label htmlFor={`locale-${question.id}`}>Locale</label><input id={`locale-${question.id}`} name="locale" defaultValue={question.locale} pattern="[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*" required /></div>
              <div className="field"><label htmlFor={`persona-${question.id}`}>Persona</label><input id={`persona-${question.id}`} name="persona" defaultValue={question.persona ?? ""} minLength={2} required /></div>
              <div className="field"><label htmlFor={`stage-${question.id}`}>Stage</label><input id={`stage-${question.id}`} name="stage" defaultValue={question.stage ?? ""} minLength={2} required /></div>
              <div className="field field-wide"><label htmlFor={`rationale-${question.id}`}>Rationale</label><textarea id={`rationale-${question.id}`} name="rationale" defaultValue={question.rationale ?? ""} rows={2} minLength={12} required /></div>
            </div>
            <SubmitButton className="button button-small" pendingLabel="Saving…">Save question</SubmitButton>
          </form> : <p>Read-only access.</p>}
          {writable ? <form action={updateQuestionStateAction} className="inline-action-form">
            <input type="hidden" name="questionId" value={question.id} />
            <input type="hidden" name="projectId" value={project?.id ?? ""} />
            <label htmlFor={`state-${question.id}`}>State</label>
            <select id={`state-${question.id}`} name="state" defaultValue={question.state}><option value="active">Active</option><option value="disqualified">Disqualified</option><option value="archived">Archived</option></select>
            <label htmlFor={`reason-${question.id}`}>Reason if disqualified</label>
            <input id={`reason-${question.id}`} name="reason" defaultValue={question.disqualification_reason ?? ""} />
            <SubmitButton className="button button-secondary button-small" pendingLabel="Updating…">Update state</SubmitButton>
          </form> : null}
        </div>
      </details>)}</div>}
    </section>
  </>;
}
