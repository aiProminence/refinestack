import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { EmptyState, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { createAdminClient } from "@/lib/supabase/server";
import { canAdminister, getDashboardContext } from "../_context";
import { disableWebhookAction, revokeTokenAction } from "./actions";
import { ApiTokenForm, WebhookForm } from "./integration-forms";
import { WorkspaceDangerZone } from "./workspace-danger-zone";

export const metadata = { title: "Integration settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await getDashboardContext();
  const query = await searchParams;
  const admin = createAdminClient();
  const owner = ctx.actor.role === "owner";
  const administrator = canAdminister(ctx.actor.role);
  const [tokensResult, endpointsResult, deliveriesResult, auditResult, workspaceResult] = await Promise.all([
    owner ? admin.from("api_tokens").select("id,name,token_prefix,scopes,expires_at,last_used_at,revoked_at,created_at").eq("workspace_id", ctx.actor.workspaceId).order("created_at", { ascending: false }).limit(50) : Promise.resolve({ data: [], error: null }),
    administrator ? admin.from("webhook_endpoints").select("id,name,endpoint_url,event_names,enabled,created_at,updated_at").eq("workspace_id", ctx.actor.workspaceId).order("created_at", { ascending: false }).limit(50) : Promise.resolve({ data: [], error: null }),
    administrator ? admin.from("webhook_deliveries").select("id,webhook_endpoint_id,event_name,status,attempt_count,response_status,delivered_at,created_at").eq("workspace_id", ctx.actor.workspaceId).order("created_at", { ascending: false }).limit(30) : Promise.resolve({ data: [], error: null }),
    administrator ? admin.from("audit_events").select("id,event_type,entity_type,actor_user_id,occurred_at").eq("workspace_id", ctx.actor.workspaceId).order("occurred_at", { ascending: false }).limit(40) : Promise.resolve({ data: [], error: null }),
    owner ? admin.from("workspaces").select("name,slug").eq("id", ctx.actor.workspaceId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  const loadError = tokensResult.error || endpointsResult.error || deliveriesResult.error || auditResult.error || workspaceResult.error;
  const tokens = tokensResult.data ?? [];
  const endpoints = endpointsResult.data ?? [];
  const deliveries = deliveriesResult.data ?? [];
  const audits = auditResult.data ?? [];

  return <div className="workspace-page">
    <PageHeader eyebrow="Integration settings" title="Controlled access, visible delivery." description="Issue scoped credentials, register signed webhook destinations, and inspect the immutable security trail." actions={<Link className="button button-secondary button-small" href="/api-docs">API documentation</Link>} />
    {loadError ? <Notice title="Integration data could not be loaded" tone="critical"><p>RefineStack did not substitute defaults. Retry after checking database availability.</p></Notice> : null}
    {query.error ? <Notice title="Integration change failed" tone="critical"><p>{query.error}</p></Notice> : null}
    {!administrator ? <Notice title="Read-only settings" tone="info"><p>Workspace administrators manage webhooks. Only owners can issue API tokens.</p></Notice> : null}

    {owner ? <section className="workspace-card"><SectionHeading title="API tokens" description="Plaintext is displayed once. Only its SHA-256 hash is stored." /><ApiTokenForm />
      {tokens.length ? <div className="table-wrap workspace-section-spaced"><table><caption>Workspace API tokens</caption><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th>Status</th><th>Control</th></tr></thead><tbody>{tokens.map((token) => {
        const expired = token.expires_at ? new Date(token.expires_at) <= new Date() : false;
        const active = !token.revoked_at && !expired;
        return <tr key={token.id}><td>{token.name}</td><td><code>{token.token_prefix}…</code></td><td>{token.scopes.join(", ")}</td><td>{token.last_used_at ? new Date(token.last_used_at).toLocaleString() : "Never"}</td><td><StatusChip tone={active ? "positive" : "neutral"}>{token.revoked_at ? "revoked" : expired ? "expired" : "active"}</StatusChip></td><td>{active ? <form action={revokeTokenAction}><input type="hidden" name="tokenId" value={token.id} /><SubmitButton className="button button-secondary button-small" pendingLabel="Revoking…">Revoke</SubmitButton></form> : "—"}</td></tr>;
      })}</tbody></table></div> : <EmptyState title="No API tokens" description="Create the first scoped token when an external integration is ready." />}
    </section> : null}

    {administrator ? <section className="workspace-card workspace-section-spaced"><SectionHeading title="Signed webhooks" description="Destinations must be public HTTPS endpoints. Redirects and private-network addresses are rejected." /><WebhookForm />
      {endpoints.length ? <div className="table-wrap workspace-section-spaced"><table><caption>Webhook endpoints</caption><thead><tr><th>Name</th><th>Destination</th><th>Events</th><th>Status</th><th>Control</th></tr></thead><tbody>{endpoints.map((endpoint) => <tr key={endpoint.id}><td>{endpoint.name}</td><td><span dir="auto">{endpoint.endpoint_url}</span></td><td>{endpoint.event_names.join(", ")}</td><td><StatusChip tone={endpoint.enabled ? "positive" : "neutral"}>{endpoint.enabled ? "enabled" : "disabled"}</StatusChip></td><td>{endpoint.enabled ? <form action={disableWebhookAction}><input type="hidden" name="endpointId" value={endpoint.id} /><SubmitButton className="button button-secondary button-small" pendingLabel="Disabling…">Disable</SubmitButton></form> : "—"}</td></tr>)}</tbody></table></div> : <EmptyState title="No webhook endpoints" description="Register a destination to receive durable run, review, and action events." />}
    </section> : null}

    {administrator ? <div className="workspace-two-column workspace-section-spaced"><section className="workspace-card workspace-card-large"><SectionHeading title="Recent deliveries" description="Retries are bounded and every attempt remains visible." />{deliveries.length ? <div className="table-wrap"><table><caption>Most recent webhook deliveries</caption><thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>HTTP</th><th>Created</th></tr></thead><tbody>{deliveries.map((delivery) => <tr key={delivery.id}><td>{delivery.event_name}</td><td><StatusChip tone={delivery.status === "delivered" ? "positive" : delivery.status === "abandoned" ? "critical" : "warning"}>{delivery.status}</StatusChip></td><td>{delivery.attempt_count}</td><td>{delivery.response_status ?? "—"}</td><td>{new Date(delivery.created_at).toLocaleString()}</td></tr>)}</tbody></table></div> : <EmptyState title="No webhook deliveries" description="Delivery records appear after a subscribed state transition." />}</section>
      <section className="workspace-card"><SectionHeading title="Audit trail" description="Recent security and configuration events." />{audits.length ? <ul className="settings-rows">{audits.map((event) => <li key={event.id}><span><strong>{event.event_type}</strong><small>{event.entity_type} · {new Date(event.occurred_at).toLocaleString()}</small></span></li>)}</ul> : <EmptyState title="No audit events" description="Audited operations will appear here." />}</section></div> : null}
    {owner && workspaceResult.data ? <WorkspaceDangerZone workspaceName={workspaceResult.data.name} workspaceSlug={workspaceResult.data.slug} /> : null}
  </div>;
}
