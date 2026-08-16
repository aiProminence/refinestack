import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createActionWithLineage,
  listActionLineageWorkspace,
  parseActionReference,
  transitionActionWithFollowUp,
} from "@/lib/db/action-lineage";
import type { DbContext, ProductDbClient } from "@/lib/db";

type Response = { data: unknown; error: unknown };
type Call = { target: string; operation: string; args: unknown[] };

class Query implements PromiseLike<Response> {
  constructor(private table: string, private response: Response, private calls: Call[]) {}
  private record(operation: string, ...args: unknown[]) { this.calls.push({ target: this.table, operation, args }); return this; }
  select(...args: unknown[]) { return this.record("select", ...args); }
  eq(...args: unknown[]) { return this.record("eq", ...args); }
  order(...args: unknown[]) { return this.record("order", ...args); }
  maybeSingle() { this.record("maybeSingle"); return Promise.resolve(this.response); }
  then<TResult1 = Response, TResult2 = never>(onfulfilled?: ((value: Response) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.response).then(onfulfilled, onrejected);
  }
}

function context(responses: Record<string, Response[]>, role: DbContext["actor"]["role"] = "analyst", rpcResponse: Response = { data: "action-a", error: null }) {
  const calls: Call[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ target: name, operation: "rpc", args: [args] });
    return rpcResponse;
  });
  const client = {
    from(table: string) {
      const response = responses[table]?.shift();
      if (!response) throw new Error(`Missing response for ${table}`);
      return new Query(table, response, calls);
    },
    rpc,
  } as unknown as ProductDbClient;
  const ctx: DbContext = { client, actor: { userId: "user-a", workspaceId: "workspace-a", role } };
  return { ctx, calls, rpc };
}

const authorized = {
  workspace_members: [{ data: { role: "analyst" }, error: null }],
  projects: [{ data: { id: "project-a" }, error: null }],
};

describe("action lineage contract", () => {
  it("parses only an explicit immutable reference kind and identifier", () => {
    expect(parseActionReference("source_version:version-a")).toEqual({ kind: "source_version", id: "version-a" });
    expect(() => parseActionReference("run:run-a")).toThrow("valid immutable evidence record");
    expect(() => parseActionReference("classification:")).toThrow("valid immutable evidence record");
  });

  it("creates an action and its exact source-version lineage through one tenant-bound RPC", async () => {
    const { ctx, rpc } = context(structuredClone(authorized));
    await expect(createActionWithLineage(ctx, {
      projectId: "project-a",
      title: "Clarify implementation evidence",
      description: "Publish one reviewed implementation guide.",
      expectedImpact: "Improve evidence coverage in the next run.",
      effort: "One editorial cycle.",
      uncertainty: "Provider retrieval may vary.",
      reference: "source_version:version-a",
      rationale: "The current source omits the verified deployment sequence.",
    })).resolves.toBe("action-a");
    expect(rpc).toHaveBeenCalledWith("create_action_with_lineage", expect.objectContaining({
      p_workspace_id: "workspace-a",
      p_project_id: "project-a",
      p_actor_id: "user-a",
      p_question_version_id: null,
      p_classification_id: null,
      p_source_version_id: "version-a",
      p_expected_impact: "Improve evidence coverage in the next run.",
      p_effort: "One editorial cycle.",
      p_uncertainty: "Provider retrieval may vary.",
      p_rationale: "The current source omits the verified deployment sequence.",
    }));
  });

  it("rejects a viewer before calling either mutation RPC", async () => {
    const responses = structuredClone(authorized);
    responses.workspace_members[0] = { data: { role: "viewer" }, error: null };
    const { ctx, rpc } = context(responses, "viewer");
    await expect(createActionWithLineage(ctx, {
      projectId: "project-a", title: "A valid action", description: "A bounded valid deliverable.",
      expectedImpact: "Test impact", effort: "Test effort", uncertainty: "Test uncertainty",
      reference: "question_version:question-v1", rationale: "Observed performance warrants a controlled test.",
    })).rejects.toThrow("analyst access");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("completes through a later run link and a factual note, never a causation flag", async () => {
    const { ctx, rpc } = context(structuredClone(authorized));
    await expect(transitionActionWithFollowUp(ctx, {
      projectId: "project-a", actionId: "action-a", status: "completed",
      followUpRunId: "run-after", outcomeNote: "The later run observed two additional owned citations.",
    })).resolves.toBe("action-a");
    expect(rpc).toHaveBeenCalledWith("transition_action_with_follow_up", {
      p_workspace_id: "workspace-a", p_project_id: "project-a", p_actor_id: "user-a",
      p_action_id: "action-a", p_status: "completed", p_follow_up_run_id: "run-after",
      p_outcome_note: "The later run observed two additional owned citations.",
    });
  });

  it("assembles visible immutable evidence and later outcomes with tenant and project scope", async () => {
    const { ctx, calls } = context({
      ...structuredClone(authorized),
      actions: [{ data: [{
        id: "action-a", workspace_id: "workspace-a", project_id: "project-a", title: "Guide",
        description: "Publish the reviewed guide.", status: "completed", expected_impact: null,
        effort: null, uncertainty: null, created_by: "user-a", completed_at: "2026-08-16T03:00:00Z",
        created_at: "2026-08-16T01:00:00Z", updated_at: "2026-08-16T03:00:00Z",
      }], error: null }],
      action_links: [{ data: [{ id: "link-a", action_id: "action-a", question_version_id: null, classification_id: "class-a", source_version_id: null, rationale: "The classification records a verified citation gap.", created_at: "2026-08-16T01:00:00Z" }], error: null }],
      action_run_links: [{ data: [{ id: "follow-a", action_id: "action-a", run_id: "run-after", outcome_note: "A later run observed an owned citation.", causation_asserted: false, created_at: "2026-08-16T03:00:00Z" }], error: null }],
      question_versions: [{ data: [], error: null }],
      brand_classifications: [{ data: [{ id: "class-a", brand_version_id: "brand-v1", mentioned: true, cited: false, explicitly_recommended: false, first_choice: false, rejected: false, rationale: "No owned citation was present.", created_at: "2026-08-16T00:30:00Z" }], error: null }],
      brand_versions: [{ data: [{ id: "brand-v1", name: "Original brand", version: 1, created_at: "2026-08-16T00:00:00Z" }], error: null }],
      source_versions: [{ data: [], error: null }],
      sources: [{ data: [], error: null }],
      runs: [{ data: [
        { id: "run-after", status: "succeeded", created_at: "2026-08-16T02:00:00Z", completed_at: "2026-08-16T02:30:00Z" },
        { id: "run-failed", status: "failed", created_at: "2026-08-16T02:00:00Z", completed_at: "2026-08-16T02:30:00Z" },
      ], error: null }],
    });
    const result = await listActionLineageWorkspace(ctx, "project-a");
    expect(result.references[0]).toMatchObject({ kind: "classification", label: "Classification: Original brand v1" });
    expect(result.followUpRuns).toEqual([{ id: "run-after", status: "succeeded", createdAt: "2026-08-16T02:00:00Z", completedAt: "2026-08-16T02:30:00Z" }]);
    expect(result.actions[0].evidenceLinks[0]).toMatchObject({ recordId: "class-a", rationale: "The classification records a verified citation gap." });
    expect(result.actions[0].followUps[0]).toMatchObject({ runId: "run-after", causationAsserted: false });
    for (const table of ["actions", "action_links", "action_run_links", "question_versions", "brand_classifications", "brand_versions", "source_versions", "sources", "runs"]) {
      const filters = calls.filter((call) => call.target === table && call.operation === "eq");
      expect(filters).toContainEqual({ target: table, operation: "eq", args: ["workspace_id", "workspace-a"] });
      expect(filters).toContainEqual({ target: table, operation: "eq", args: ["project_id", "project-a"] });
    }
  });

  it("defines deferred orphan checks, composite tenant FKs, immutable links, RLS, and service-only mutations", () => {
    const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260816157000_action_lineage_contract.sql"), "utf8");
    const cascadeFix = readFileSync(resolve(process.cwd(), "supabase/migrations/20260816157200_fix_action_run_project_cascade.sql"), "utf8");
    expect(migration).toContain("deferrable initially deferred");
    expect(migration).toContain("references public.actions(id, project_id, workspace_id) on delete cascade");
    expect(cascadeFix).toContain("foreign key (run_id, project_id, workspace_id)");
    expect(cascadeFix).toContain("references public.runs(id, project_id, workspace_id) on delete cascade");
    expect(migration).toContain("causation_asserted boolean not null default false");
    expect(migration).toContain("alter column expected_impact set not null");
    expect(migration).toContain("create policy action_run_links_read");
    expect(migration).toContain("grant select on public.action_run_links to authenticated");
    expect(migration).toContain("grant execute on function public.create_action_with_lineage");
    expect(migration).toContain("grant execute on function public.transition_action_with_follow_up");
    expect(migration).toContain("Completed action lineage is immutable.");
  });
});
