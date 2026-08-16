"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { createEvidenceAction } from "./actions";

const MAX_EVIDENCE_FILE_BYTES = 1_000_000;

export function CreateEvidenceForm({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<"url" | "text" | "file">("url");

  return <form action={createEvidenceAction} className="product-form">
    <input type="hidden" name="projectId" value={projectId} />
    <div className="form-grid">
      <div className="field">
        <label htmlFor="source-kind">Evidence type</label>
        <select id="source-kind" name="kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="url">Public URL</option>
          <option value="text">Supplied text</option>
          <option value="file">Private file</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="source-name">Source name</label>
        <input id="source-name" name="name" required maxLength={160} />
      </div>
      {kind === "url" ? <div className="field field-wide">
        <label htmlFor="source-url">URL</label>
        <input id="source-url" name="url" type="url" inputMode="url" required />
        <p>RefineStack retrieves readable text over DNS-pinned HTTPS and stores an immutable content hash.</p>
      </div> : null}
      {kind === "text" ? <div className="field field-wide">
        <label htmlFor="source-content">Source text</label>
        <textarea id="source-content" name="content" rows={7} required maxLength={1_000_000} />
      </div> : null}
      {kind === "file" ? <div className="field field-wide">
        <label htmlFor="source-file">Private evidence file</label>
        <input id="source-file" name="file" type="file" required accept=".txt,.md,.csv,.json,.html,text/plain,text/markdown,text/csv,application/json,text/html" />
        <p>UTF-8 .txt, .md, .csv, .json, or .html only; maximum {MAX_EVIDENCE_FILE_BYTES.toLocaleString("en-US")} bytes. The original stays in private storage.</p>
      </div> : null}
      <div className="field">
        <label htmlFor="source-authority">Authority weight</label>
        <input id="source-authority" name="authorityWeight" type="number" min="0" max="1" step="0.05" defaultValue="0.70" required aria-describedby="source-authority-help" />
        <p id="source-authority-help">0 is untrusted; 1 is the most authoritative. Conflict ranking uses this exact value.</p>
      </div>
      <div className="field">
        <label htmlFor="source-freshness">Fresh for (days)</label>
        <input id="source-freshness" name="freshnessDays" type="number" min="1" max="3650" step="1" defaultValue="90" required aria-describedby="source-freshness-help" />
        <p id="source-freshness-help">After this many days, the immutable version is marked stale.</p>
      </div>
      {kind !== "url" ? <div className="field field-wide">
        <label htmlFor="source-evidence-date">Retrieved or verified on <span>(optional)</span></label>
        <input id="source-evidence-date" name="evidenceDate" type="date" />
        <p>Leave blank when the date is unknown. RefineStack will show an explicit unknown-freshness warning.</p>
      </div> : null}
    </div>
    <fieldset className="policy-checks">
      <legend>Use policy</legend>
      <label><input type="checkbox" name="retrievalAllowed" defaultChecked /> Retrieval allowed</label>
      <label><input type="checkbox" name="quotingAllowed" defaultChecked /> Quotation allowed</label>
      <label><input type="checkbox" name="exportAllowed" defaultChecked /> Export allowed</label>
    </fieldset>
    <div className="form-footer">
      <p>The first immutable source version is created with a SHA-256 content hash.</p>
      <SubmitButton pendingLabel="Adding…">Add evidence</SubmitButton>
    </div>
  </form>;
}
