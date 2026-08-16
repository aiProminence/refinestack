import "server-only";

import { DatabaseContractError, databaseFailure } from "@/lib/db/errors";
import type { DbContext } from "@/lib/db/types";
import type { Json, SourceRow, WorkspaceRole } from "@/types/database";

type SourceVersionRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  source_id: string;
  version: number;
  content_text: string | null;
  storage_path: string | null;
  content_hash: string;
  mime_type: string | null;
  retrieved_at: string | null;
  valid_from: string;
  valid_until: string | null;
  retrieval_metadata: Json;
  retrieval_allowed: boolean;
  quoting_allowed: boolean;
  export_allowed: boolean;
  authority_weight_snapshot: number;
  freshness_days_snapshot: number;
  prompt_injection_flags: string[];
  created_by: string | null;
  created_at: string;
};

const roleRank: Record<WorkspaceRole, number> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };

async function requireEvidenceWriter(ctx: DbContext, projectId: string, sourceId: string) {
  const [membership, source] = await Promise.all([
    ctx.client.from("workspace_members").select("role")
      .eq("workspace_id", ctx.actor.workspaceId).eq("user_id", ctx.actor.userId).maybeSingle(),
    ctx.client.from("sources").select("*")
      .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).eq("id", sourceId).maybeSingle(),
  ]);
  if (membership.error) databaseFailure("Unable to verify evidence access.", membership.error);
  if (!membership.data || membership.data.role !== ctx.actor.role) {
    throw new DatabaseContractError("Workspace membership is required.", "UNAUTHORIZED");
  }
  if (roleRank[membership.data.role] < roleRank.analyst) {
    throw new DatabaseContractError("This operation requires analyst access.", "FORBIDDEN");
  }
  if (source.error) databaseFailure("Unable to authorize the evidence source.", source.error);
  if (!source.data) throw new DatabaseContractError("Evidence source was not found in this workspace and project.", "NOT_FOUND");
  return source.data;
}

export async function getEvidenceSource(ctx: DbContext, projectId: string, sourceId: string): Promise<SourceRow> {
  const { data, error } = await ctx.client.from("sources").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).eq("id", sourceId).maybeSingle();
  if (error) databaseFailure("Unable to load the evidence source.", error);
  if (!data) throw new DatabaseContractError("Evidence source was not found in this workspace and project.", "NOT_FOUND");
  return data;
}

export async function listSourceVersions(ctx: DbContext, projectId: string, sourceId: string): Promise<SourceVersionRow[]> {
  await getEvidenceSource(ctx, projectId, sourceId);
  const { data, error } = await ctx.client.from("source_versions").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId).eq("source_id", sourceId)
    .order("version", { ascending: false });
  if (error) databaseFailure("Unable to list immutable evidence versions.", error);
  return data ?? [];
}

export async function appendSourceVersion(ctx: DbContext, input: {
  projectId: string;
  sourceId: string;
  contentText?: string;
  storagePath?: string;
  contentHash: string;
  mimeType?: string;
  retrievedAt?: string;
  retrievalMetadata?: Json;
}) {
  await requireEvidenceWriter(ctx, input.projectId, input.sourceId);
  const { data, error } = await ctx.client.rpc("append_evidence_source_version", {
    p_workspace_id: ctx.actor.workspaceId,
    p_project_id: input.projectId,
    p_source_id: input.sourceId,
    p_actor_id: ctx.actor.userId,
    p_content_text: input.contentText ?? null,
    p_storage_path: input.storagePath ?? null,
    p_content_hash: input.contentHash,
    p_mime_type: input.mimeType ?? null,
    p_retrieved_at: input.retrievedAt ?? null,
    p_retrieval_metadata: input.retrievalMetadata ?? {},
  });
  if (error) databaseFailure("Unable to append the immutable evidence version.", error);
  if (!data) databaseFailure("The evidence version RPC returned no identifier.", null);
  const [source, version] = await Promise.all([
    getEvidenceSource(ctx, input.projectId, input.sourceId),
    ctx.client.from("source_versions").select("*")
      .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", input.projectId).eq("source_id", input.sourceId).eq("id", data).single(),
  ]);
  if (version.error) databaseFailure("The appended evidence version could not be loaded.", version.error);
  return { source, version: version.data as SourceVersionRow };
}

export async function archiveSource(ctx: DbContext, projectId: string, sourceId: string) {
  await requireEvidenceWriter(ctx, projectId, sourceId);
  const { error } = await ctx.client.rpc("archive_evidence_source", {
    p_workspace_id: ctx.actor.workspaceId,
    p_project_id: projectId,
    p_source_id: sourceId,
    p_actor_id: ctx.actor.userId,
  });
  if (error) databaseFailure("Unable to archive the evidence source.", error);
  return getEvidenceSource(ctx, projectId, sourceId);
}
