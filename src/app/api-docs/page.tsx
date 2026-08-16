import type { Metadata } from "next";
import Link from "next/link";
import { brand } from "@/lib/brand";

export const metadata: Metadata = { title: "API documentation", description: `Use the ${brand.name} API to inspect projects, request evidence runs and export owned workspace data.` };

const endpoints = [
  ["GET", "/api/v1/projects", "List projects", "read"],
  ["GET", "/api/v1/projects/{projectId}", "Retrieve one project", "read"],
  ["GET", "/api/v1/projects/{projectId}/runs", "List project runs", "read"],
  ["POST", "/api/v1/projects/{projectId}/runs", "Request a run", "run"],
  ["GET", "/api/v1/runs/{runId}", "Retrieve a run and its jobs", "read"],
  ["POST", "/api/v1/runs/{runId}/cancel", "Cancel a queued or running run", "run"],
  ["GET", "/api/v1/runs/{runId}/observations", "List captures and citations", "read"],
  ["GET", "/api/v1/runs/{runId}/export?format=json|csv", "Export a sanitized run", "export"],
];

function Code({ children }: { children: string }) {
  return <pre className="api-code-block"><code>{children}</code></pre>;
}

export default function ApiDocsPage() {
  return <main className="legal-page shell">
    <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
    <span className="eyebrow">Developer API · v1</span>
    <h1>Evidence workflows, with explicit boundaries.</h1>
    <p>The API exposes workspace-owned projects, runs, observations and sanitized exports. It does not expose provider credentials, raw provider payloads, restricted source content or audit metadata.</p>

    <section>
      <h2>Authentication and roles</h2>
      <p>Send a workspace API token as <code>Authorization: Bearer rfs_…</code>. Tokens are displayed once when provisioned by a workspace owner, stored as SHA-256 hashes, can expire or be revoked, and stop working when their creating owner is no longer a workspace member.</p>
      <p>Scopes are <code>read</code>, <code>run</code> and <code>export</code>. Read accepts any current member role, run requires analyst or higher, and export requires a current owner. The token must also contain the requested scope.</p>
    </section>

    <section>
      <h2>Endpoints</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th><th>Scope</th></tr></thead>
        <tbody>{endpoints.map(([method, path, purpose, scope]) => <tr key={`${method}-${path}`}>
          <td><code>{method}</code></td><td><code>{path}</code></td><td>{purpose}</td><td><code>{scope}</code></td>
        </tr>)}</tbody>
      </table></div>
    </section>

    <section>
      <h2>Pagination</h2>
      <p>List endpoints accept <code>limit</code> from 1 to 100 and an opaque <code>cursor</code>. Responses contain <code>items</code> and <code>nextCursor</code>. Cursors are signed, must not be edited, and should be treated as short-lived navigation state.</p>
    </section>

    <section>
      <h2>Requesting a run</h2>
      <p>Every run request requires an <code>Idempotency-Key</code> header. Repeating the same key and body returns the original run. Reusing a key with different questions or providers returns <code>409 idempotency_conflict</code>. RefineStack derives and reserves the maximum calls and cost from its server-owned provider caps; clients cannot supply or lower that estimate.</p>
      <Code>{`curl -X POST https://${brand.domain}/api/v1/projects/PROJECT_ID/runs \\
  -H "Authorization: Bearer rfs_REDACTED" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: monitor-2026-08-16-01" \\
  -d '{"questionVersionIds":["QUESTION_VERSION_ID"],"providers":["openai"]}'`}</Code>
    </section>

    <section>
      <h2>Cancelling a run</h2>
      <p>Analysts, administrators and owners can cancel a queued or running run. The cancellation is atomic: queued jobs are stopped, while a provider request already in flight may settle and its durable observation remains available. Repeating a successful cancellation is safe and returns the original cancellation with <code>replayed: true</code>. A completed, partial or failed run returns <code>409 run_not_cancellable</code>.</p>
      <Code>{`curl -X POST https://${brand.domain}/api/v1/runs/RUN_ID/cancel \\
  -H "Authorization: Bearer rfs_REDACTED" \\
  -H "Content-Type: application/json" \\
  -d '{"reason":"Superseded by the corrected question cohort."}'`}</Code>
    </section>

    <section>
      <h2>Export policy</h2>
      <p>Exports retain safe citation lineage such as URLs, titles, positions and managed source-version IDs. A managed citation excerpt is included only when both its immutable source version and current source policy allow quotation and export. Otherwise <code>evidence_excerpt</code> is <code>null</code> and <code>evidence_redaction_reason</code> explains the restriction. Raw managed source content and storage locations are never exported.</p>
    </section>

    <section>
      <h2>Responses, errors and limits</h2>
      <p>JSON success responses use <code>{`{"data": …, "requestId": "…"}`}</code>. Errors use a stable code, safe message and the same request ID. Object lookups return the same <code>404 not_found</code> response whether an ID is missing or belongs to another workspace.</p>
      <Code>{`{
  "error": {
    "code": "validation_failed",
    "message": "The request body is invalid.",
    "requestId": "019…"
  }
}`}</Code>
      <p>Default per-token limits are 60 read, 10 run and 10 export requests per minute. Admission is enforced atomically per token across application instances. Successful responses include <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code> and an ISO timestamp in <code>X-RateLimit-Reset</code>; a limited request returns <code>429</code> with a bounded <code>Retry-After</code>. Workspace quotas and provider availability may impose lower practical limits.</p>
    </section>

    <section>
      <h2>Webhooks</h2>
      <p>Configured HTTPS endpoints receive a raw JSON envelope with event <code>id</code>, unique <code>deliveryId</code>, <code>event</code>, <code>createdAt</code>, <code>workspaceId</code> and <code>data</code>. Verify <code>X-RefineStack-Signature</code> as HMAC-SHA256 over <code>timestamp.rawBody</code>, where the timestamp is Unix milliseconds. Require the body delivery ID to equal <code>X-RefineStack-Delivery</code>, reject timestamps outside five minutes, and atomically consume that delivery ID to prevent replay.</p>
      <p>Deliveries use bounded exponential retry, never follow redirects, and re-check the destination at delivery time. Supported events are run started/completed/partial/failed, review required and action created/completed.</p>
    </section>

    <p><Link className="text-link" href="/security">Review the security model</Link> or contact <a className="text-link" href={`mailto:${brand.email}`}>{brand.email}</a> for beta access.</p>
  </main>;
}
