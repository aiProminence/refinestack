import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { enforceCitationExportPolicy } from "@/lib/platform/export-policy";
import { cancelMonitoringRun } from "@/lib/platform/run-cancellation";
import type { Database } from "@/types/database";

const workspaceId = "018f47d2-83c3-7b80-a855-69b9298ab2a1";
const projectId = "018f47d2-83c3-7b80-a855-69b9298ab2a2";
const runId = "018f47d2-83c3-7b80-a855-69b9298ab2a3";
const actorId = "018f47d2-83c3-7b80-a855-69b9298ab2a4";

function query(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.in.mockResolvedValue(result);
  return chain;
}

describe("run cancellation", () => {
  it("passes the tenant and actor boundary to the atomic cancellation RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: runId, status: "cancelled", cancelled_at: "2026-08-16T12:00:00+00:00", cancellation_reason: "Superseded", replayed: false },
      error: null,
    });
    const admin = { rpc } as unknown as SupabaseClient<Database>;
    await expect(cancelMonitoringRun(admin, { workspaceId, runId, actorId, reason: "Superseded" })).resolves.toMatchObject({
      id: runId, status: "cancelled", replayed: false,
    });
    expect(rpc).toHaveBeenCalledWith("cancel_monitoring_run", {
      p_workspace_id: workspaceId, p_run_id: runId, p_actor_id: actorId, p_reason: "Superseded",
    });
  });

  it.each([
    ["42501", 403, "forbidden"],
    ["P0002", 404, "not_found"],
    ["55000", 409, "run_not_cancellable"],
    ["22023", 422, "validation_failed"],
    ["XX000", 503, "cancellation_unavailable"],
  ])("maps database error %s to a stable API problem", async (code, status, problemCode) => {
    const admin = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code } }) } as unknown as SupabaseClient<Database>;
    await expect(cancelMonitoringRun(admin, { workspaceId, runId, actorId, reason: "Superseded" }))
      .rejects.toMatchObject({ status, code: problemCode });
  });

  it("fails closed when the RPC response violates its contract", async () => {
    const admin = { rpc: vi.fn().mockResolvedValue({ data: { status: "cancelled" }, error: null }) } as unknown as SupabaseClient<Database>;
    await expect(cancelMonitoringRun(admin, { workspaceId, runId, actorId, reason: "Superseded" }))
      .rejects.toMatchObject({ status: 503, code: "cancellation_unavailable" });
  });
});

describe("citation export policy", () => {
  const observationId = "018f47d2-83c3-7b80-a855-69b9298ab2a5";
  const allowedVersion = "018f47d2-83c3-7b80-a855-69b9298ab2b1";
  const quoteBlockedVersion = "018f47d2-83c3-7b80-a855-69b9298ab2b2";
  const exportBlockedVersion = "018f47d2-83c3-7b80-a855-69b9298ab2b3";
  const missingVersion = "018f47d2-83c3-7b80-a855-69b9298ab2b4";
  const allowedSource = "018f47d2-83c3-7b80-a855-69b9298ab2c1";
  const quoteBlockedSource = "018f47d2-83c3-7b80-a855-69b9298ab2c2";
  const exportBlockedSource = "018f47d2-83c3-7b80-a855-69b9298ab2c3";
  const citation = (id: string, sourceVersionId: string | null) => ({
    id, observation_id: observationId, url: "https://example.test/source", canonical_url: "https://example.test/source",
    title: "Lineage title", position: 1, evidence_excerpt: "Restricted evidence", source_version_id: sourceVersionId,
  });

  it("retains external and allowed excerpts while redacting every restricted or unresolved managed excerpt", async () => {
    const versions = query({ data: [
      { id: allowedVersion, source_id: allowedSource, quoting_allowed: true, export_allowed: true },
      { id: quoteBlockedVersion, source_id: quoteBlockedSource, quoting_allowed: false, export_allowed: true },
      { id: exportBlockedVersion, source_id: exportBlockedSource, quoting_allowed: true, export_allowed: true },
    ], error: null });
    const policies = query({ data: [
      { id: allowedSource, quoting_allowed: true, export_allowed: true },
      { id: quoteBlockedSource, quoting_allowed: true, export_allowed: true },
      { id: exportBlockedSource, quoting_allowed: true, export_allowed: false },
    ], error: null });
    const admin = { from: vi.fn((table: string) => table === "source_versions" ? versions : policies) } as unknown as SupabaseClient<Database>;
    const result = await enforceCitationExportPolicy(admin, workspaceId, projectId, [
      citation("018f47d2-83c3-7b80-a855-69b9298ab2d1", null),
      citation("018f47d2-83c3-7b80-a855-69b9298ab2d2", allowedVersion),
      citation("018f47d2-83c3-7b80-a855-69b9298ab2d3", quoteBlockedVersion),
      citation("018f47d2-83c3-7b80-a855-69b9298ab2d4", exportBlockedVersion),
      citation("018f47d2-83c3-7b80-a855-69b9298ab2d5", missingVersion),
    ]);

    expect(result.map(({ evidence_excerpt, evidence_redaction_reason }) => ({ evidence_excerpt, evidence_redaction_reason }))).toEqual([
      { evidence_excerpt: "Restricted evidence", evidence_redaction_reason: null },
      { evidence_excerpt: "Restricted evidence", evidence_redaction_reason: null },
      { evidence_excerpt: null, evidence_redaction_reason: "quotation_restricted" },
      { evidence_excerpt: null, evidence_redaction_reason: "source_export_restricted" },
      { evidence_excerpt: null, evidence_redaction_reason: "policy_unresolved" },
    ]);
    expect(result[3]).toMatchObject({ url: null, canonical_url: null, title: null, evidence_redaction_reason: "source_export_restricted" });
    expect(result[4]).toMatchObject({ url: null, canonical_url: null, title: null, evidence_redaction_reason: "policy_unresolved" });
  });

  it("does not perform policy lookups for provider citations without managed lineage", async () => {
    const admin = { from: vi.fn() } as unknown as SupabaseClient<Database>;
    const [result] = await enforceCitationExportPolicy(admin, workspaceId, projectId, [
      citation("018f47d2-83c3-7b80-a855-69b9298ab2d6", null),
    ]);
    expect(result.evidence_excerpt).toBe("Restricted evidence");
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("does not export when policy storage is unavailable", async () => {
    const versions = query({ data: null, error: { code: "XX000" } });
    const admin = { from: vi.fn(() => versions) } as unknown as SupabaseClient<Database>;
    await expect(enforceCitationExportPolicy(admin, workspaceId, projectId, [
      citation("018f47d2-83c3-7b80-a855-69b9298ab2d7", allowedVersion),
    ])).rejects.toMatchObject({ status: 503, code: "export_unavailable" });
  });
});
