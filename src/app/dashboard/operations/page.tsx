import Link from "next/link";
import { EmptyState, Notice, PageHeader, SectionHeading, StatusChip } from "@/components/product-ui";
import { SubmitButton } from "@/components/submit-button";
import { getProviderHealth, getRunPreflight, listProjects, listQuestionSets, listSchedules } from "@/lib/db";
import { providers as providerDefinitions } from "@/lib/providers";
import { createScheduleAction, resetScheduleCircuitAction, saveActiveCohortAction, updateScheduleAction } from "../_actions";
import { canAdminister, canWrite, getDashboardContext } from "../_context";

export const metadata = { title: "Operations" };

export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const [ctx, query] = await Promise.all([getDashboardContext(), searchParams]);
  const projects = await listProjects(ctx);
  const project = projects[0];
  const [health, schedules, sets, preflight] = await Promise.all([
    getProviderHealth(ctx),
    project ? listSchedules(ctx, project.id) : [],
    project ? listQuestionSets(ctx, project.id) : [],
    project ? getRunPreflight(ctx, project.id) : null,
  ]);
  const admin = canAdminister(ctx.actor.role);
  const writable = canWrite(ctx.actor.role);
  const verifiedProviderCount = preflight?.providers.filter((provider) => provider.enabled && provider.state === "healthy").length ?? 0;
  const schedulable = Boolean(admin && project && preflight?.activeQuestionSetId && verifiedProviderCount);

  return <>
    <PageHeader eyebrow="Operations" title="Make reliability visible." description="Review schedules and repository-recorded provider health without exposing credentials." />
    {query.saved ? <Notice title="Saved" tone="info"><p>{query.saved}</p></Notice> : null}
    {query.error ? <Notice title="Schedule change failed" tone="critical"><p>{query.error}</p></Notice> : null}
    <div className="workspace-two-column">
      <section className="workspace-card workspace-card-large">
        <SectionHeading title="Provider health" description="A healthy state requires a successful runtime check; credential presence is not enough." />
        <ul className="provider-health-list">{health.map((provider) => {
          const definition = providerDefinitions.find((item) => item.key === provider.provider);
          const healthy = provider.enabled && provider.state === "healthy";
          return <li key={provider.provider}><div><strong>{definition?.name ?? provider.provider}</strong><small>{definition?.surface ?? "Provider surface"}</small></div><div className="provider-status"><StatusChip tone={healthy ? "positive" : provider.state === "degraded" ? "warning" : "critical"}>{provider.enabled ? provider.state : "disabled"}</StatusChip><small>{provider.remediation ?? (provider.lastCheckedAt ? `Checked ${new Date(provider.lastCheckedAt).toLocaleString()}` : "Runtime check pending")}</small></div></li>;
        })}</ul>
      </section>
      <section className="workspace-card">
        <SectionHeading title="Current cohort" description="Only an exact saved question set can be scheduled." />
        <p><strong>{preflight?.activeQuestionVersionIds.length ?? 0}</strong> active immutable question versions</p>
        <p><strong>{sets.length}</strong> saved question sets</p>
        <StatusChip tone={preflight?.activeQuestionSetId ? "positive" : "warning"}>{preflight?.activeQuestionSetId ? "Exact set ready" : "Question set missing"}</StatusChip>
        {project && writable && Boolean(preflight?.activeQuestionVersionIds.length) && !preflight?.activeQuestionSetId ? <form className="cohort-form" action={saveActiveCohortAction}>
          <input type="hidden" name="projectId" value={project.id} />
          <label htmlFor="cohort-name">Immutable set name</label>
          <input id="cohort-name" name="name" defaultValue={`${project.name} active cohort`} required />
          <SubmitButton className="button button-secondary button-small" pendingLabel="Saving cohort…">Save active cohort</SubmitButton>
        </form> : null}
      </section>
    </div>
    {project && admin ? <section className="workspace-card workspace-section-spaced">
      <SectionHeading title="Create schedule" description="Schedules use the current exact question set and providers verified by a successful manual capture." />
      {!schedulable ? <Notice title="Schedule creation blocked" tone="warning"><p>An exact active question set and at least one successfully verified provider are required.</p></Notice> : null}
      <form action={createScheduleAction} className="product-form"><fieldset disabled={!schedulable}>
        <input type="hidden" name="projectId" value={project.id} />
        <div className="form-grid">
          <div className="field"><label htmlFor="schedule-name">Schedule name</label><input id="schedule-name" name="name" required /></div>
          <div className="field"><label htmlFor="schedule-frequency">Frequency</label><select id="schedule-frequency" name="frequency"><option value="weekly">Weekly</option><option value="daily">Daily</option><option value="monthly">Monthly</option></select></div>
          <div className="field"><label htmlFor="schedule-timezone">Timezone</label><input id="schedule-timezone" name="timezone" defaultValue="Asia/Kuala_Lumpur" required /></div>
          <div className="field"><label htmlFor="schedule-local-time">Local run time</label><input id="schedule-local-time" name="localTime" type="time" defaultValue="09:00" required /></div>
          <div className="field"><label htmlFor="schedule-next">First run (UTC)</label><input id="schedule-next" name="nextRunAt" type="datetime-local" required aria-describedby="schedule-next-help" /><small id="schedule-next-help">Subsequent runs follow the local time and timezone above.</small></div>
          <div className="field"><label htmlFor="schedule-overlap">Overlap policy</label><select id="schedule-overlap" name="overlapPolicy"><option value="skip">Skip while prior run is active</option><option value="queue">Queue after prior run</option></select></div>
        </div>
        <SubmitButton pendingLabel="Creating…">Create schedule</SubmitButton>
      </fieldset></form>
    </section> : null}
    <section className="workspace-card workspace-section-spaced">
      <SectionHeading title="Schedules" description={`${schedules.length} stored schedule${schedules.length === 1 ? "" : "s"}`} />
      {!schedules.length ? <EmptyState title="No monitoring schedules" description="Schedules require an exact saved question set and at least one available provider." actionHref="/dashboard/runs/new" actionLabel="Open preflight" /> : <div className="table-wrap"><table><caption>Monitoring schedules for {project?.name}</caption><thead><tr><th scope="col">Name</th><th scope="col">Cadence</th><th scope="col">Providers</th><th scope="col">Next run</th><th scope="col">Health</th><th scope="col">Control</th></tr></thead><tbody>{schedules.map((schedule) => <tr key={schedule.id}><td>{schedule.name}</td><td>{schedule.frequency}, {schedule.local_time} {schedule.timezone}</td><td>{schedule.providers.join(", ")}</td><td>{schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : "Not scheduled"}</td><td><StatusChip tone={schedule.circuit_opened_at ? "critical" : schedule.enabled ? "positive" : "neutral"}>{schedule.circuit_opened_at ? "circuit open" : schedule.enabled ? "enabled" : "disabled"}</StatusChip></td><td>{admin ? schedule.circuit_opened_at ? <form action={resetScheduleCircuitAction}><input type="hidden" name="projectId" value={schedule.project_id} /><input type="hidden" name="scheduleId" value={schedule.id} /><SubmitButton className="button button-secondary button-small" pendingLabel="Resetting…">Reset circuit</SubmitButton></form> : <form action={updateScheduleAction}><input type="hidden" name="scheduleId" value={schedule.id} /><input type="hidden" name="enabled" value={schedule.enabled ? "false" : "true"} /><SubmitButton className="button button-secondary button-small" pendingLabel="Updating…">{schedule.enabled ? "Disable" : "Enable"}</SubmitButton></form> : "Read only"}</td></tr>)}</tbody></table></div>}
    </section>
    <p className="workspace-footnote">Repeated failure opens a circuit breaker instead of continuing to spend or silently missing work. <Link href="/dashboard/usage">Review usage</Link>.</p>
  </>;
}
