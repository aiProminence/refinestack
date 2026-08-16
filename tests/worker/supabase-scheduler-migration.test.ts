import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve("supabase/migrations/20260816160000_supabase_worker_scheduler.sql"), "utf8");

describe("Supabase worker scheduler contract", () => {
  it("schedules the durable worker every five minutes through pg_cron and pg_net", () => {
    expect(migration).toContain("create extension if not exists pg_cron");
    expect(migration).toContain("create extension if not exists pg_net");
    expect(migration).toContain("'refinestack-worker-every-five-minutes'");
    expect(migration).toContain("'*/5 * * * *'");
    expect(migration).toContain("net.http_post(");
    expect(migration).toContain("timeout_milliseconds := 300000");
  });

  it("reads configuration from Vault, validates it, and exposes no callable scheduler RPC", () => {
    expect(migration).toContain("from vault.decrypted_secrets");
    expect(migration).toContain("name = 'refinestack_worker_url'");
    expect(migration).toContain("name = 'refinestack_worker_secret'");
    expect(migration).toContain("security definer\nset search_path = ''");
    expect(migration).toContain("revoke all on function private.dispatch_refinestack_worker() from public, anon, authenticated, service_role");
    expect(migration).not.toMatch(/Bearer [A-Za-z0-9_-]{32,}/u);
  });
});
