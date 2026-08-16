import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve("supabase/migrations/20260816156000_evidence_quality_contract.sql"), "utf8");
const immutableDeletes = readFileSync(resolve("supabase/migrations/20260816156500_immutable_evidence_claim_deletes.sql"), "utf8");

describe("evidence quality database contract", () => {
  it("snapshots required quality fields and backfills legacy ingestion through a trigger", () => {
    expect(migration).toContain("alter column authority_weight set not null");
    expect(migration).toContain("alter column freshness_days set not null");
    expect(migration).toContain("create trigger default_source_version_quality before insert on public.source_versions");
    expect(migration).toContain("new.authority_weight_snapshot, s.authority_weight");
    expect(migration).toContain("new.freshness_days_snapshot, s.freshness_days");
  });

  it("persists deterministic injection flags without tool or model execution", () => {
    expect(migration).toContain("private.detect_evidence_prompt_injection");
    expect(migration).toContain("new.prompt_injection_flags := private.detect_evidence_prompt_injection(new.content_text)");
    expect(migration).not.toMatch(/http|net\.|openai|anthropic|google_ai/iu);
  });

  it("tenant-checks service-only claim creation and makes claims immutable", () => {
    const claimRpc = migration.slice(migration.indexOf("create or replace function public.record_evidence_claim"));
    expect(claimRpc).toContain("sv.workspace_id = p_workspace_id");
    expect(claimRpc).toContain("sv.project_id = p_project_id");
    expect(claimRpc).toContain("wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id");
    expect(immutableDeletes).toContain("create trigger immutable_source_claims before update or delete");
    expect(immutableDeletes).toContain("current_setting('app.workspace_deletion_id', true)");
    expect(immutableDeletes).toContain("= old.workspace_id::text");
    expect(migration).toContain("revoke all on function public.record_evidence_claim");
    expect(migration).toMatch(/grant execute on function public\.record_evidence_claim\(uuid,uuid,uuid,uuid,text,text,text\)\s+to service_role/iu);
  });

  it("rejects appends to archived sources and snapshots policy plus authority/freshness", () => {
    const appendRpc = migration.slice(
      migration.indexOf("create or replace function public.append_quality_evidence_source_version"),
      migration.indexOf("create or replace function public.record_evidence_claim"),
    );
    expect(appendRpc).toContain("source_row.state <> 'active'");
    expect(appendRpc).toContain("source_row.retrieval_allowed, source_row.quoting_allowed, source_row.export_allowed");
    expect(appendRpc).toContain("p_authority_weight, p_freshness_days, injection_flags");
  });
});
