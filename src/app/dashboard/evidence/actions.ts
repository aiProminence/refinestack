"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  getProject,
} from "@/lib/db";
import { archiveSource, getEvidenceSource, listSourceVersions } from "@/lib/evidence/lifecycle";
import {
  parseEvidenceFile,
  removeOrphanedEvidenceUpload,
  retrieveEvidenceUrl,
  uploadEvidenceFile,
} from "@/lib/evidence/ingest";
import {
  appendQualityEvidenceVersion,
  createQualityEvidenceSource,
  recordEvidenceClaim,
} from "@/lib/evidence/quality-store";
import { createAdminClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";
import { getDashboardContext } from "../_context";

function required(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function requiredFile(formData: FormData) {
  const value = formData.get("file");
  if (!(value instanceof File) || !value.name || value.size === 0) throw new Error("Choose an evidence file to upload.");
  return value;
}

function qualityConfiguration(formData: FormData) {
  const authorityWeight = Number(required(formData, "authorityWeight"));
  const freshnessDays = Number(required(formData, "freshnessDays"));
  if (!Number.isFinite(authorityWeight) || authorityWeight < 0 || authorityWeight > 1) {
    throw new Error("Authority weight must be between 0 and 1.");
  }
  if (!Number.isInteger(freshnessDays) || freshnessDays < 1 || freshnessDays > 3650) {
    throw new Error("Freshness must be a whole number from 1 to 3,650 days.");
  }
  return { authorityWeight, freshnessDays };
}

function evidenceDate(formData: FormData) {
  const value = formData.get("evidenceDate");
  if (value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("Evidence date is invalid.");
  const timestamp = `${value}T00:00:00.000Z`;
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > Date.now()) throw new Error("Evidence date cannot be in the future.");
  return timestamp;
}

function message(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 240) : "The request could not be completed.";
}

function destination(kind: "saved" | "error", value: string) {
  return `/dashboard/evidence?${kind}=${encodeURIComponent(value)}`;
}

async function removeUploadWhenUnreferenced(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  path: string | undefined,
) {
  if (!path) return;
  const { data, error } = await admin.from("source_versions")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("storage_path", path)
    .limit(1)
    .maybeSingle();
  if (!error && !data) await removeOrphanedEvidenceUpload(admin, path);
}

function fileMetadata(file: Awaited<ReturnType<typeof parseEvidenceFile>>): Json {
  return {
    ingestion: "private_file_v1",
    original_filename: file.originalFilename,
    stored_bytes: file.size,
    encoding: "utf-8",
  };
}

export async function createEvidenceAction(formData: FormData) {
  const userCtx = await getDashboardContext();
  const admin = createAdminClient();
  let storagePath: string | undefined;
  try {
    const projectId = required(formData, "projectId");
    await getProject(userCtx, projectId);
    const kind = required(formData, "kind");
    if (kind !== "url" && kind !== "text" && kind !== "file") throw new Error("Choose a supported evidence type.");

    const common = {
      projectId,
      name: required(formData, "name"),
      policy: {
        retrievalAllowed: formData.get("retrievalAllowed") === "on",
        quotingAllowed: formData.get("quotingAllowed") === "on",
        exportAllowed: formData.get("exportAllowed") === "on",
      },
      quality: qualityConfiguration(formData),
    };

    if (kind === "url") {
      const retrieved = await retrieveEvidenceUrl(required(formData, "url"));
      await createQualityEvidenceSource({ client: admin, actor: userCtx.actor }, {
        ...common,
        kind,
        originalUrl: retrieved.originalUrl,
        canonicalUrl: retrieved.canonicalUrl,
        contentText: retrieved.contentText,
        contentHash: retrieved.contentHash,
        mimeType: retrieved.mimeType,
        retrievedAt: retrieved.retrievedAt,
        retrievalMetadata: retrieved.retrievalMetadata,
      });
    } else if (kind === "text") {
      const content = required(formData, "content");
      if (content.length > 1_000_000) throw new Error("Evidence text exceeds the 1,000,000-character limit.");
      await createQualityEvidenceSource({ client: admin, actor: userCtx.actor }, {
        ...common,
        kind,
        contentText: content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        mimeType: "text/plain",
        retrievedAt: evidenceDate(formData),
        retrievalMetadata: { ingestion: "supplied_text_v1", stored_bytes: Buffer.byteLength(content) },
      });
    } else {
      const parsed = await parseEvidenceFile(requiredFile(formData));
      storagePath = await uploadEvidenceFile(admin, {
        workspaceId: userCtx.actor.workspaceId,
        projectId,
        file: parsed,
      });
      await createQualityEvidenceSource({ client: admin, actor: userCtx.actor }, {
        ...common,
        kind,
        contentText: parsed.contentText,
        storagePath,
        contentHash: parsed.contentHash,
        mimeType: parsed.mimeType,
        retrievedAt: evidenceDate(formData),
        retrievalMetadata: fileMetadata(parsed),
      });
    }
    revalidatePath("/dashboard/evidence");
  } catch (error) {
    try {
      await removeUploadWhenUnreferenced(admin, userCtx.actor.workspaceId, storagePath);
    } catch (cleanupError) {
      redirect(destination("error", `${message(error)} ${message(cleanupError)}`));
    }
    redirect(destination("error", message(error)));
  }
  redirect(destination("saved", "Evidence source added."));
}

export async function appendEvidenceVersionAction(formData: FormData) {
  const userCtx = await getDashboardContext();
  const admin = createAdminClient();
  let storagePath: string | undefined;
  try {
    const projectId = required(formData, "projectId");
    const sourceId = required(formData, "sourceId");
    const source = await getEvidenceSource(userCtx, projectId, sourceId);
    if (source.state !== "active") throw new Error("Archived evidence cannot receive a new version.");
    const quality = qualityConfiguration(formData);

    if (source.kind === "url") {
      if (!source.original_url) throw new Error("This URL source has no retrieval URL.");
      const retrieved = await retrieveEvidenceUrl(source.original_url);
      await appendQualityEvidenceVersion({ client: admin, actor: userCtx.actor }, {
        projectId,
        sourceId,
        contentText: retrieved.contentText,
        contentHash: retrieved.contentHash,
        mimeType: retrieved.mimeType,
        retrievedAt: retrieved.retrievedAt,
        retrievalMetadata: retrieved.retrievalMetadata,
        quality,
      });
    } else if (source.kind === "text") {
      const content = required(formData, "content");
      if (content.length > 1_000_000) throw new Error("Evidence text exceeds the 1,000,000-character limit.");
      await appendQualityEvidenceVersion({ client: admin, actor: userCtx.actor }, {
        projectId,
        sourceId,
        contentText: content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        mimeType: "text/plain",
        retrievedAt: evidenceDate(formData),
        retrievalMetadata: { ingestion: "supplied_text_v1", stored_bytes: Buffer.byteLength(content) },
        quality,
      });
    } else {
      const parsed = await parseEvidenceFile(requiredFile(formData));
      storagePath = await uploadEvidenceFile(admin, {
        workspaceId: userCtx.actor.workspaceId,
        projectId,
        sourceId,
        file: parsed,
      });
      await appendQualityEvidenceVersion({ client: admin, actor: userCtx.actor }, {
        projectId,
        sourceId,
        contentText: parsed.contentText,
        storagePath,
        contentHash: parsed.contentHash,
        mimeType: parsed.mimeType,
        retrievedAt: evidenceDate(formData),
        retrievalMetadata: fileMetadata(parsed),
        quality,
      });
    }
    revalidatePath("/dashboard/evidence");
  } catch (error) {
    try {
      await removeUploadWhenUnreferenced(admin, userCtx.actor.workspaceId, storagePath);
    } catch (cleanupError) {
      redirect(destination("error", `${message(error)} ${message(cleanupError)}`));
    }
    redirect(destination("error", message(error)));
  }
  redirect(destination("saved", "A new immutable evidence version was added."));
}

export async function archiveEvidenceAction(formData: FormData) {
  const userCtx = await getDashboardContext();
  try {
    const projectId = required(formData, "projectId");
    const sourceId = required(formData, "sourceId");
    await getEvidenceSource(userCtx, projectId, sourceId);
    await archiveSource({ client: createAdminClient(), actor: userCtx.actor }, projectId, sourceId);
    revalidatePath("/dashboard/evidence");
  } catch (error) {
    redirect(destination("error", message(error)));
  }
  redirect(destination("saved", "Evidence source archived. Its immutable history was retained."));
}

export async function recordEvidenceClaimAction(formData: FormData) {
  const userCtx = await getDashboardContext();
  try {
    const projectId = required(formData, "projectId");
    const sourceId = required(formData, "sourceId");
    const sourceVersionId = required(formData, "sourceVersionId");
    const [source, versions] = await Promise.all([
      getEvidenceSource(userCtx, projectId, sourceId),
      listSourceVersions(userCtx, projectId, sourceId),
    ]);
    if (source.state !== "active") throw new Error("Archived evidence cannot receive a new claim.");
    if (!versions.some((version) => version.id === sourceVersionId)) throw new Error("The selected evidence version does not belong to this source.");
    const claimText = required(formData, "claimText");
    const excerpt = formData.get("evidenceExcerpt");
    const conflictGroup = formData.get("conflictGroup");
    await recordEvidenceClaim({ client: createAdminClient(), actor: userCtx.actor }, {
      projectId,
      sourceVersionId,
      claimText,
      evidenceExcerpt: typeof excerpt === "string" ? excerpt.trim() : undefined,
      conflictGroup: typeof conflictGroup === "string" ? conflictGroup.trim() : undefined,
    });
    revalidatePath("/dashboard/evidence");
  } catch (error) {
    redirect(destination("error", message(error)));
  }
  redirect(destination("saved", "Immutable evidence claim recorded."));
}
