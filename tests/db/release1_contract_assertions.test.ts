import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260815205035_release_1_product_schema.sql"),
  "utf8",
);

describe("Release 1 database security contract", () => {
  it("uses one mailbox-bound invitation registry and removes the legacy registry", () => {
    expect(migration).toContain("private.hook_require_beta_invite");
    expect(migration).toContain("public.workspace_invitations");
    expect(migration).toContain("drop table if exists private.beta_invites");
    expect(migration).toContain("invited_user_id = new.id");
    expect(migration).toContain("bootstrap_workspace_from_invitation");
    expect(migration).toContain("Only an owner can invite another owner.");
    expect(migration).not.toContain("grant select, insert, update, delete on public.workspaces to authenticated");
  });

  it("keeps privileged worker operations service-role only and security invoker", () => {
    expect(migration).toContain("create or replace function public.lease_capture_jobs");
    expect(migration).toContain("security invoker");
    expect(migration).toContain("revoke all on function public.lease_capture_jobs(text, integer, integer) from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.lease_capture_jobs(text, integer, integer) to service_role");
  });

  it("recomputes parent run status after expired leases", () => {
    const recovery = migration.slice(
      migration.indexOf("create or replace function public.recover_expired_capture_leases"),
      migration.indexOf("create or replace function public.enqueue_due_schedules"),
    );
    expect(recovery).toContain("update public.runs");
    expect(recovery).toContain("completed_at");
    expect(recovery).toContain("'partial'::public.run_status");
  });

  it("requires owner authority to modify an owner membership", () => {
    const policies = migration.slice(migration.indexOf("create policy workspace_members_update_admin"));
    expect(policies).toContain("private.has_workspace_role(workspace_id, 'owner')");
    expect(policies).toContain("role <> 'owner'");
    expect(migration).toContain("protect_last_workspace_owner");
  });

  it("enforces same-workspace composite lineage", () => {
    expect(migration).toContain("observations_run_project_workspace_fkey");
    expect(migration).toContain("observations_question_project_workspace_fkey");
    expect(migration).toContain("citations_observation_project_workspace_fkey");
    expect(migration).toContain("brandVersionId");
  });
});
