import { describe, expect, it, vi } from "vitest";
import { appendSourceVersion, archiveSource, getEvidenceSource, listSourceVersions } from "@/lib/evidence/lifecycle";
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
  single() { this.record("single"); return Promise.resolve(this.response); }
  then<TResult1 = Response, TResult2 = never>(onfulfilled?: ((value: Response) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.response).then(onfulfilled, onrejected);
  }
}

const source = {
  id: "source-a", workspace_id: "workspace-a", project_id: "project-a", kind: "text", name: "Notes",
  original_url: null, canonical_url: null, state: "active", retrieval_allowed: true, quoting_allowed: true,
  export_allowed: true, authority_weight: null, freshness_days: null, created_by: "user-a",
  created_at: "2026-08-16T00:00:00Z", updated_at: "2026-08-16T00:00:00Z",
};

const version = {
  id: "version-2", workspace_id: "workspace-a", project_id: "project-a", source_id: "source-a", version: 2,
  content_text: "New", storage_path: null, content_hash: "hash", mime_type: "text/plain", retrieved_at: null,
  valid_from: "2026-08-16T01:00:00Z", valid_until: null, retrieval_metadata: {}, retrieval_allowed: true,
  quoting_allowed: true, export_allowed: true, created_by: "user-a", created_at: "2026-08-16T01:00:00Z",
};

function context(responses: Record<string, Response[]>, rpcResponse: Response = { data: "version-2", error: null }) {
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
  const ctx: DbContext = { client, actor: { userId: "user-a", workspaceId: "workspace-a", role: "analyst" } };
  return { ctx, calls, rpc };
}

describe("evidence lifecycle authorization", () => {
  it("scopes source and version reads to workspace, project, and source", async () => {
    const { ctx, calls } = context({
      sources: [{ data: source, error: null }, { data: source, error: null }],
      source_versions: [{ data: [version], error: null }],
    });
    await expect(getEvidenceSource(ctx, "project-a", "source-a")).resolves.toMatchObject({ id: "source-a" });
    await expect(listSourceVersions(ctx, "project-a", "source-a")).resolves.toEqual([version]);
    for (const table of ["sources", "source_versions"]) {
      const equals = calls.filter((call) => call.target === table && call.operation === "eq");
      expect(equals).toContainEqual({ target: table, operation: "eq", args: ["workspace_id", "workspace-a"] });
      expect(equals).toContainEqual({ target: table, operation: "eq", args: ["project_id", "project-a"] });
      expect(equals).toContainEqual({ target: table, operation: "eq", args: [table === "sources" ? "id" : "source_id", "source-a"] });
    }
  });

  it("authorizes an analyst and passes tenant-bound facts to the append RPC", async () => {
    const { ctx, rpc } = context({
      workspace_members: [{ data: { role: "analyst" }, error: null }],
      sources: [{ data: source, error: null }, { data: source, error: null }],
      source_versions: [{ data: version, error: null }],
    });
    await expect(appendSourceVersion(ctx, {
      projectId: "project-a", sourceId: "source-a", contentText: "New", contentHash: "hash", mimeType: "text/plain",
    })).resolves.toMatchObject({ source: { id: "source-a" }, version: { id: "version-2" } });
    expect(rpc).toHaveBeenCalledWith("append_evidence_source_version", expect.objectContaining({
      p_workspace_id: "workspace-a", p_project_id: "project-a", p_source_id: "source-a", p_actor_id: "user-a",
      p_content_text: "New", p_storage_path: null, p_content_hash: "hash",
    }));
  });

  it("rejects stale or insufficient membership before any lifecycle RPC", async () => {
    const { ctx, rpc } = context({
      workspace_members: [{ data: { role: "viewer" }, error: null }],
      sources: [{ data: source, error: null }],
    });
    ctx.actor.role = "viewer";
    await expect(archiveSource(ctx, "project-a", "source-a")).rejects.toThrow("analyst access");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("archives only after authorization and reloads the retained source", async () => {
    const archived = { ...source, state: "archived" };
    const { ctx, rpc } = context({
      workspace_members: [{ data: { role: "analyst" }, error: null }],
      sources: [{ data: source, error: null }, { data: archived, error: null }],
    }, { data: "source-a", error: null });
    await expect(archiveSource(ctx, "project-a", "source-a")).resolves.toMatchObject({ id: "source-a", state: "archived" });
    expect(rpc).toHaveBeenCalledWith("archive_evidence_source", {
      p_workspace_id: "workspace-a", p_project_id: "project-a", p_source_id: "source-a", p_actor_id: "user-a",
    });
  });
});
