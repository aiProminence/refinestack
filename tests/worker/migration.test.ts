import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve("supabase/migrations/20260816124500_durable_capture_worker.sql"), "utf8");

describe("durable worker database contract", () => {
  it("hydrates leased jobs and atomically persists success and failure usage", () => {
    expect(migration).toContain("hydrate_capture_job_v2");
    expect(migration).toContain("complete_capture_job_v2");
    expect(migration).toContain("fail_capture_job_v2");
    expect(migration).toContain("job.lease_expires_at <= now()");
    expect(migration.match(/insert into public\.usage_events/g)).toHaveLength(2);
    expect(migration).toContain("Classifications must exactly match the frozen run brand cohort.");
    expect(migration).toContain("Retry delay exceeds the worker bound.");
  });

  it("keeps worker RPCs service-role only", () => {
    expect(migration.match(/revoke all on function public\.(?:hydrate|complete|fail)_capture_job_v2/g)).toHaveLength(3);
    expect(migration.match(/grant execute on function public\.(?:hydrate|complete|fail)_capture_job_v2/g)).toHaveLength(3);
  });
});
