import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260816159500_timezone_schedule_recurrence.sql",
), "utf8");

describe("timezone schedule recurrence", () => {
  it("preserves local wall time, validates zones, and makes circuit reset service-only", () => {
    expect(migration).toContain("pg_catalog.pg_timezone_names");
    expect(migration).toContain("private.next_schedule_occurrence");
    expect(migration).toContain("least(p_month_day");
    expect(migration).toContain("create or replace function public.reset_schedule_circuit");
    expect(migration).toContain("grant execute on function public.reset_schedule_circuit(uuid,uuid,uuid,uuid) to service_role");
    expect(migration).toContain("revoke all on function public.reset_schedule_circuit(uuid,uuid,uuid,uuid)\nfrom public, anon, authenticated");
  });
});
