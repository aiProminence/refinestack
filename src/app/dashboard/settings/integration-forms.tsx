"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { createTokenAction, createWebhookAction, type SecretActionState } from "./actions";

const initial: SecretActionState = { ok: false, message: "" };

function SecretResult({ state }: { state: SecretActionState }) {
  if (!state.message) return null;
  return <div className={state.ok ? "form-success" : "form-error"} role={state.ok ? "status" : "alert"} aria-live="polite"><p>{state.message}</p>{state.secret ? <code className="one-time-secret" dir="ltr">{state.secret}</code> : null}</div>;
}

export function ApiTokenForm() {
  const [state, action] = useActionState(createTokenAction, initial);
  return <form action={action} className="product-form"><div className="form-grid"><div className="field"><label htmlFor="token-name">Token name</label><input id="token-name" name="name" minLength={2} maxLength={80} required /></div><div className="field"><label htmlFor="token-expiry">Expires at in UTC (optional)</label><input id="token-expiry" name="expiresAt" type="datetime-local" /></div><fieldset className="field field-wide"><legend>Scopes</legend><label><input type="checkbox" name="read" defaultChecked /> Read</label><label><input type="checkbox" name="run" /> Create runs</label><label><input type="checkbox" name="export" /> Export</label></fieldset></div><SubmitButton pendingLabel="Issuing…">Issue token</SubmitButton><SecretResult state={state} /></form>;
}

export function WebhookForm() {
  const [state, action] = useActionState(createWebhookAction, initial);
  const events = ["run.started", "run.completed", "run.partial", "run.failed", "review.required", "action.created", "action.completed"];
  return <form action={action} className="product-form"><div className="form-grid"><div className="field"><label htmlFor="webhook-name">Endpoint name</label><input id="webhook-name" name="name" minLength={2} maxLength={80} required /></div><div className="field"><label htmlFor="webhook-url">Public HTTPS URL</label><input id="webhook-url" name="endpointUrl" type="url" pattern="https://.*" required /></div><fieldset className="field field-wide"><legend>Events</legend>{events.map((event) => <label key={event}><input type="checkbox" name={event} defaultChecked={event.startsWith("run.")} /> {event}</label>)}</fieldset></div><SubmitButton pendingLabel="Registering…">Register webhook</SubmitButton><SecretResult state={state} /></form>;
}
