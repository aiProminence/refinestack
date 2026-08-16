import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/types/database";
import { ApiProblem } from "./api";

const citationSchema = z.object({
  id: z.string().uuid(),
  observation_id: z.string().uuid(),
  url: z.string(),
  canonical_url: z.string(),
  title: z.string().nullable(),
  position: z.number().int().nullable(),
  evidence_excerpt: z.string().nullable(),
  source_version_id: z.string().uuid().nullable(),
}).strict();

const versionSchema = z.object({
  id: z.string().uuid(),
  source_id: z.string().uuid(),
  quoting_allowed: z.boolean(),
  export_allowed: z.boolean(),
});
const sourcePolicySchema = z.object({
  id: z.string().uuid(),
  quoting_allowed: z.boolean(),
  export_allowed: z.boolean(),
});

type Citation = z.infer<typeof citationSchema>;
type RedactionReason = "source_export_restricted" | "quotation_restricted" | "policy_unresolved";

export type ExportCitation = Omit<Citation, "url" | "canonical_url" | "title" | "evidence_excerpt"> & {
  url: string | null;
  canonical_url: string | null;
  title: string | null;
  evidence_excerpt: string | null;
  evidence_redaction_reason: RedactionReason | null;
};

function unavailable(): never {
  throw new ApiProblem(503, "export_unavailable", "Export data is temporarily unavailable.");
}

/**
 * Redacts managed evidence unless its immutable version resolves to a source
 * that permits both quotation and export. Missing policy lineage fails closed.
 * Provider citations without a managed source version are unaffected.
 */
export async function enforceCitationExportPolicy(
  admin: SupabaseClient<Database>, workspaceId: string, projectId: string, rawCitations: unknown,
): Promise<ExportCitation[]> {
  const parsedCitations = z.array(citationSchema).safeParse(rawCitations);
  if (!parsedCitations.success) unavailable();
  const citations = parsedCitations.data;
  const versionIds = [...new Set(citations.flatMap((citation) => citation.source_version_id ? [citation.source_version_id] : []))];
  if (versionIds.length === 0) {
    return citations.map((citation) => ({ ...citation, evidence_redaction_reason: null }));
  }

  // Query rows are validated before policy decisions so malformed lineage also
  // fails closed instead of silently releasing an excerpt.
  const client = admin as unknown as SupabaseClient;
  const { data: rawVersions, error: versionError } = await client.from("source_versions")
    .select("id,source_id,quoting_allowed,export_allowed")
    .eq("workspace_id", workspaceId).eq("project_id", projectId).in("id", versionIds);
  if (versionError) unavailable();
  const parsedVersions = z.array(versionSchema).safeParse(rawVersions ?? []);
  if (!parsedVersions.success) unavailable();

  const sourceIds = [...new Set(parsedVersions.data.map((version) => version.source_id))];
  const { data: rawPolicies, error: policyError } = sourceIds.length === 0
    ? { data: [], error: null }
    : await client.from("sources").select("id,quoting_allowed,export_allowed")
      .eq("workspace_id", workspaceId).eq("project_id", projectId).in("id", sourceIds);
  if (policyError) unavailable();
  const parsedPolicies = z.array(sourcePolicySchema).safeParse(rawPolicies ?? []);
  if (!parsedPolicies.success) unavailable();

  const versionById = new Map(parsedVersions.data.map((version) => [version.id, version]));
  const policyBySource = new Map(parsedPolicies.data.map((policy) => [policy.id, policy]));
  return citations.map((citation) => {
    if (!citation.source_version_id) return { ...citation, evidence_redaction_reason: null };
    const version = versionById.get(citation.source_version_id);
    const policy = version ? policyBySource.get(version.source_id) : undefined;
    let reason: RedactionReason | null = null;
    if (!version || !policy) reason = "policy_unresolved";
    else if (!version.export_allowed || !policy.export_allowed) reason = "source_export_restricted";
    else if (!version.quoting_allowed || !policy.quoting_allowed) reason = "quotation_restricted";
    return {
      ...citation,
      url: reason === "source_export_restricted" || reason === "policy_unresolved" ? null : citation.url,
      canonical_url: reason === "source_export_restricted" || reason === "policy_unresolved" ? null : citation.canonical_url,
      title: reason === "source_export_restricted" || reason === "policy_unresolved" ? null : citation.title,
      evidence_excerpt: reason ? null : citation.evidence_excerpt,
      evidence_redaction_reason: reason,
    };
  });
}
