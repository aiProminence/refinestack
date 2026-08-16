import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve("supabase/migrations/20260816159000_durable_expired_lease_accounting.sql"), "utf8");

describe("expired capture lease accounting contract", () => {
  it("persists one ambiguous attempt and one idempotent usage event before recovery", () => {
    expect(migration).toContain("add column if not exists lease_started_at timestamptz");
    expect(migration).toContain("insert into public.capture_attempts");
    expect(migration).toContain("on conflict (run_item_id, attempt_number) do nothing");
    expect(migration).toContain("insert into public.usage_events");
    expect(migration).toContain("'lease-expired:' || job.id::text || ':' || job.attempt_count::text");
    expect(migration).toContain("1, null, 0, 0, 0, false, true");
    expect(migration.indexOf("insert into public.capture_attempts")).toBeLessThan(migration.indexOf("update public.run_items\n    set status = next_status"));
  });

  it("keeps lease and recovery RPCs service-role only", () => {
    expect(migration).toContain("revoke all on function public.lease_capture_jobs(text, integer, integer)");
    expect(migration).toContain("revoke all on function public.recover_expired_capture_leases(timestamptz)");
    expect(migration).toContain("grant execute on function public.lease_capture_jobs(text, integer, integer)");
    expect(migration).toContain("grant execute on function public.recover_expired_capture_leases(timestamptz)");
  });
});
