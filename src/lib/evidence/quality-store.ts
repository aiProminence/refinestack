import "server-only";

import { databaseFailure } from "@/lib/db/errors";
import type { DbContext } from "@/lib/db/types";
import type { Json } from "@/types/database";

export type EvidenceQualityConfiguration = {
  authorityWeight: number;
  freshnessDays: number;
};

export type QualityEvidencePayload = {
  projectId: string;
  kind: "url" | "text" | "file";
  name: string;
  originalUrl?: string;
  canonicalUrl?: string;
  contentText?: string;
  storagePath?: string;
  contentHash: string;
  mimeType?: string;
  retrievedAt?: string;
  retrievalMetadata?: Json;
  policy: { retrievalAllowed: boolean; quotingAllowed: boolean; exportAllowed: boolean };
  quality: EvidenceQualityConfiguration;
};

export type QualityVersionPayload = Omit<QualityEvidencePayload, "kind" | "name" | "originalUrl" | "canonicalUrl" | "policy"> & {
  sourceId: string;
};

export async function createQualityEvidenceSource(ctx: DbContext, input: QualityEvidencePayload) {
  const { data, error } = await ctx.client.rpc("create_quality_evidence_source", {
    p_workspace_id: ctx.actor.workspaceId,
    p_project_id: input.projectId,
    p_actor_id: ctx.actor.userId,
    p_kind: input.kind,
    p_name: input.name,
    p_original_url: input.originalUrl ?? null,
    p_canonical_url: input.canonicalUrl ?? null,
    p_content_text: input.contentText ?? null,
    p_storage_path: input.storagePath ?? null,
    p_content_hash: input.contentHash,
    p_mime_type: input.mimeType ?? null,
    p_retrieved_at: input.retrievedAt ?? null,
    p_retrieval_metadata: input.retrievalMetadata ?? {},
    p_retrieval_allowed: input.policy.retrievalAllowed,
    p_quoting_allowed: input.policy.quotingAllowed,
    p_export_allowed: input.policy.exportAllowed,
    p_authority_weight: input.quality.authorityWeight,
    p_freshness_days: input.quality.freshnessDays,
  });
  if (error) databaseFailure("Unable to create evidence with its quality contract.", error);
  if (!data) databaseFailure("The evidence quality RPC returned no source identifier.", null);
  return data;
}

export async function appendQualityEvidenceVersion(ctx: DbContext, input: QualityVersionPayload) {
  const { data, error } = await ctx.client.rpc("append_quality_evidence_source_version", {
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
    p_authority_weight: input.quality.authorityWeight,
    p_freshness_days: input.quality.freshnessDays,
  });
  if (error) databaseFailure("Unable to append evidence with its quality contract.", error);
  if (!data) databaseFailure("The evidence quality RPC returned no version identifier.", null);
  return data;
}

export async function listEvidenceClaims(ctx: DbContext, projectId: string) {
  const { data, error } = await ctx.client.from("source_claims").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) databaseFailure("Unable to load evidence claims.", error);
  return data ?? [];
}

export async function recordEvidenceClaim(ctx: DbContext, input: {
  projectId: string;
  sourceVersionId: string;
  claimText: string;
  evidenceExcerpt?: string;
  conflictGroup?: string;
}) {
  const { data, error } = await ctx.client.rpc("record_evidence_claim", {
    p_workspace_id: ctx.actor.workspaceId,
    p_project_id: input.projectId,
    p_source_version_id: input.sourceVersionId,
    p_actor_id: ctx.actor.userId,
    p_claim_text: input.claimText,
    p_evidence_excerpt: input.evidenceExcerpt ?? "",
    p_conflict_group: input.conflictGroup ?? "",
  });
  if (error) databaseFailure("Unable to record the immutable evidence claim.", error);
  if (!data) databaseFailure("The evidence claim RPC returned no identifier.", null);
  return data;
}
