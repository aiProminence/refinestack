"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { deleteWorkspaceAction, type WorkspaceDeletionActionState } from "./actions";

const initialState: WorkspaceDeletionActionState = { ok: false, message: "" };

export function WorkspaceDangerZone({ workspaceName, workspaceSlug }: {
  workspaceName: string;
  workspaceSlug: string;
}) {
  const [state, action] = useActionState(deleteWorkspaceAction, initialState);

  return <section className="workspace-card workspace-section-spaced danger-zone" aria-labelledby="workspace-deletion-title">
    <div>
      <h2 id="workspace-deletion-title">Delete workspace</h2>
      <p>This permanently removes {workspaceName}, including its projects, captures, integrations, and member access. Stored evidence files are removed by a durable exact-object cleanup job. This cannot be undone.</p>
    </div>
    <form action={action} className="product-form" aria-describedby="workspace-deletion-guidance">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="workspace-confirmation">Type <code dir="ltr">{workspaceSlug}</code> to confirm</label>
          <input id="workspace-confirmation" name="confirmation" type="text" autoComplete="off" spellCheck={false} required />
        </div>
        <div className="field">
          <label htmlFor="workspace-deletion-password">Current password</label>
          <input id="workspace-deletion-password" name="password" type="password" autoComplete="current-password" required />
        </div>
      </div>
      <div className="form-footer">
        <p id="workspace-deletion-guidance">Only a current owner can submit this operation. Your password is verified again immediately before deletion.</p>
        <SubmitButton className="button button-danger button-small" pendingLabel="Deleting workspace…">Permanently delete workspace</SubmitButton>
      </div>
      {state.message ? <div className={state.ok ? "form-success" : "form-error"} role={state.ok ? "status" : "alert"} aria-live="polite">{state.message}</div> : null}
    </form>
  </section>;
}
