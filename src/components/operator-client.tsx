"use client";

import Link from "next/link";
import { useActionState } from "react";
import { runOperatorAction, type OperatorActionState } from "@/app/dashboard/operator/actions";

const initialState: OperatorActionState = { result: null, error: null };
const intents = [
  ["run_status", "What is the latest run status?"],
  ["review_queue", "What needs human review?"],
  ["find_evidence", "What evidence and citations exist?"],
  ["explain_metric", "Explain a metric"],
  ["next_actions", "What actions remain open?"],
] as const;
const metrics = [
  ["capture_coverage", "Capture coverage"], ["mention_rate", "Mention rate"],
  ["mention_share", "Mention share"], ["recommendation_rate", "Recommendation rate"],
  ["recommendation_share", "Recommendation share"], ["first_choice_rate", "First-choice rate"],
  ["owned_citation_rate", "Owned citation rate"], ["evidence_support_rate", "Evidence support rate"],
] as const;

export function OperatorClient({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(runOperatorAction, initialState);
  return <details className="operator-panel">
    <summary><span className="operator-orb" aria-hidden="true">R</span><span><strong>RefineStack operator</strong><small>Deterministic workspace answers</small></span></summary>
    <div className="operator-body">
      <p>Choose an allowlisted question. Answers use current workspace records only—no model generation.</p>
      <form action={action} className="product-form">
        <fieldset><input type="hidden" name="projectId" value={projectId} />
          <div className="field"><label htmlFor="operator-intent">Workspace question</label><select id="operator-intent" name="intent">{intents.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="field"><label htmlFor="operator-metric">Metric <span>(used for metric explanations)</span></label><select id="operator-metric" name="metricKey" defaultValue="recommendation_share">{metrics.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <button type="submit" disabled={pending}>{pending ? "Reading records…" : "Answer from records"}</button>
        </fieldset>
      </form>
      <div className="operator-result" aria-live="polite">
        {state.error ? <p role="alert">{state.error}</p> : null}
        {state.result ? <section aria-labelledby="operator-result-heading">
          <h2 id="operator-result-heading">{state.result.heading}</h2>
          <p>{state.result.answer}</p>
          <dl className="definition-list">{state.result.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
          <div className="empty-actions">{state.result.links.map((link) => <Link className="text-link" href={link.href} key={link.href}>{link.label}</Link>)}</div>
          {state.result.limitations.length ? <details><summary>Limitations</summary><ul>{state.result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></details> : null}
          {state.result.asOf ? <small>Record time: {state.result.asOf}</small> : null}
        </section> : null}
      </div>
    </div>
  </details>;
}
