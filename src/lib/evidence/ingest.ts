import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeExternalFetch } from "@/lib/security/external-url";
import type { Database } from "@/types/database";

export const EVIDENCE_STORAGE_BUCKET = "evidence-private";
export const MAX_EVIDENCE_FILE_BYTES = 1_000_000;

const FILE_TYPES = {
  ".txt": { mimeType: "text/plain", accepted: new Set(["text/plain"]) },
  ".md": { mimeType: "text/markdown", accepted: new Set(["text/markdown", "text/plain"]) },
  ".csv": { mimeType: "text/csv", accepted: new Set(["text/csv", "text/plain", "application/csv"]) },
  ".json": { mimeType: "application/json", accepted: new Set(["application/json", "text/json", "text/plain"]) },
  ".html": { mimeType: "text/html", accepted: new Set(["text/html", "application/xhtml+xml", "text/plain"]) },
} as const;

type SupportedExtension = keyof typeof FILE_TYPES;

const SUPPORTED_TEXT_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "text/html",
  "text/plain",
  "text/xml",
]);

function decodeEntities(value: string) {
  const codePoint = (raw: string, radix: number) => {
    const parsed = Number.parseInt(raw, radix);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0x10ffff ? String.fromCodePoint(parsed) : "�";
  };
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/gu, (_match, code: string) => codePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => codePoint(code, 16));
}

export function htmlToText(value: string) {
  return decodeEntities(value
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<!--([\s\S]*?)-->/gu, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/giu, "\n")
    .replace(/<[^>]+>/gu, " "))
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function fileExtension(name: string): SupportedExtension | null {
  const match = /\.[a-z0-9]+$/iu.exec(name.trim().toLowerCase());
  return match && match[0] in FILE_TYPES ? match[0] as SupportedExtension : null;
}

function normalizedMimeType(value: string) {
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function sanitizeEvidenceFilename(value: string) {
  const basename = value.normalize("NFKC").replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  const extension = fileExtension(basename);
  if (!extension) throw new Error("Evidence files must use a .txt, .md, .csv, .json, or .html extension.");
  const stem = basename.slice(0, -extension.length)
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 96);
  if (!stem) throw new Error("The evidence filename must contain a readable name.");
  return `${stem}${extension}`;
}

export type ParsedEvidenceFile = {
  bytes: Uint8Array;
  contentText: string;
  contentHash: string;
  mimeType: string;
  originalFilename: string;
  safeFilename: string;
  size: number;
};

export async function parseEvidenceFile(file: File): Promise<ParsedEvidenceFile> {
  if (!(file instanceof File)) throw new Error("Choose an evidence file to upload.");
  if (file.size === 0) throw new Error("The evidence file is empty.");
  if (file.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(`Evidence files must be ${MAX_EVIDENCE_FILE_BYTES.toLocaleString("en-US")} bytes or smaller.`);
  }

  const safeFilename = sanitizeEvidenceFilename(file.name);
  const extension = fileExtension(safeFilename)!;
  const declaredMime = normalizedMimeType(file.type);
  if (declaredMime && declaredMime !== "application/octet-stream" && !FILE_TYPES[extension].accepted.has(declaredMime as never)) {
    throw new Error(`The declared file type ${declaredMime} does not match ${extension}.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
  } catch {
    throw new Error("Evidence files must contain valid UTF-8 text.");
  }
  if (/\0|[\u0001-\u0008\u000B\u000C\u000E-\u001F]/u.test(decoded)) {
    throw new Error("Evidence files cannot contain binary or unsafe control characters.");
  }
  if (extension === ".json") {
    try {
      JSON.parse(decoded);
    } catch {
      throw new Error("The JSON evidence file is not valid JSON.");
    }
  }
  const contentText = extension === ".html" ? htmlToText(decoded) : decoded.trim();
  if (!contentText) throw new Error("The evidence file contains no readable text.");

  return {
    bytes,
    contentText,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    mimeType: FILE_TYPES[extension].mimeType,
    originalFilename: file.name,
    safeFilename,
    size: bytes.byteLength,
  };
}

function safePathSegment(value: string, label: string) {
  const result = value.toLowerCase().replace(/[^a-z0-9-]/gu, "");
  if (!result) throw new Error(`A valid ${label} is required for evidence storage.`);
  return result;
}

export function buildEvidenceStoragePath(input: {
  workspaceId: string;
  projectId: string;
  sourceId?: string;
  safeFilename: string;
  objectId?: string;
}) {
  const workspace = safePathSegment(input.workspaceId, "workspace identifier");
  const project = safePathSegment(input.projectId, "project identifier");
  const source = safePathSegment(input.sourceId ?? "pending", "source identifier");
  const object = safePathSegment(input.objectId ?? randomUUID(), "object identifier");
  const filename = sanitizeEvidenceFilename(input.safeFilename);
  return `${workspace}/${project}/${source}/${object}-${filename}`;
}

export async function uploadEvidenceFile(
  client: SupabaseClient<Database>,
  input: { workspaceId: string; projectId: string; sourceId?: string; file: ParsedEvidenceFile },
) {
  const path = buildEvidenceStoragePath({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sourceId: input.sourceId,
    safeFilename: input.file.safeFilename,
  });
  const body = input.file.bytes.buffer.slice(
    input.file.bytes.byteOffset,
    input.file.bytes.byteOffset + input.file.bytes.byteLength,
  ) as ArrayBuffer;
  const { data, error } = await client.storage.from(EVIDENCE_STORAGE_BUCKET).upload(path, body, {
    cacheControl: "0",
    contentType: input.file.mimeType,
    upsert: false,
  });
  if (error) throw new Error(`The private evidence file could not be stored: ${error.message}`);
  if (!data?.path) throw new Error("The private evidence store did not return an object path.");
  return data.path;
}

export async function removeOrphanedEvidenceUpload(client: SupabaseClient<Database>, path: string) {
  const { error } = await client.storage.from(EVIDENCE_STORAGE_BUCKET).remove([path]);
  if (error) throw new Error(`The failed evidence upload could not be cleaned up: ${error.message}`);
}

export type RetrievedEvidence = {
  originalUrl: string;
  canonicalUrl: string;
  contentText: string;
  contentHash: string;
  mimeType: string;
  retrievedAt: string;
  retrievalMetadata: {
    status: number;
    contentLength: number;
    retrieval: "dns_pinned_https";
  };
};

const TRACKING_PARAMETERS = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid",
]);

export function canonicalizeEvidenceUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}

export async function retrieveEvidenceUrl(
  value: string,
  options: { fetcher?: typeof safeExternalFetch; now?: () => Date } = {},
): Promise<RetrievedEvidence> {
  const fetcher = options.fetcher ?? safeExternalFetch;
  const response = await fetcher(value, {
    method: "GET",
    headers: {
      accept: "text/html, text/plain, application/json, application/ld+json, application/xml;q=0.8",
      "user-agent": "RefineStackEvidenceBot/1.0",
    },
  }, { timeoutMs: 15_000, maxBytes: 1_000_000, maxRedirects: 3 });
  if (!response.ok) throw new Error(`Evidence retrieval returned HTTP ${response.status}.`);
  const mimeType = (response.headers.get("content-type") ?? "text/plain").split(";", 1)[0].trim().toLowerCase();
  if (!SUPPORTED_TEXT_TYPES.has(mimeType)) throw new Error(`Evidence content type ${mimeType || "unknown"} is not supported.`);
  const raw = await response.text();
  const contentText = mimeType === "text/html" || mimeType === "application/xhtml+xml" ? htmlToText(raw) : raw.trim();
  if (!contentText) throw new Error("Evidence retrieval returned no readable text.");
  if (contentText.length > 1_000_000) throw new Error("Evidence text exceeded the stored-content limit.");
  const finalUrl = response.headers.get("x-refinestack-final-url") ?? value;
  const canonicalUrl = canonicalizeEvidenceUrl(finalUrl);
  return {
    originalUrl: value,
    canonicalUrl,
    contentText,
    contentHash: createHash("sha256").update(contentText).digest("hex"),
    mimeType,
    retrievedAt: (options.now ?? (() => new Date()))().toISOString(),
    retrievalMetadata: {
      status: response.status,
      contentLength: Buffer.byteLength(contentText),
      retrieval: "dns_pinned_https",
    },
  };
}
