import "server-only";

import { isIP } from "node:net";
import { canonicalizeEvidenceUrl, htmlToText } from "@/lib/evidence/ingest";
import { safeExternalFetch } from "./external-url";

export type DomainDiagnostic = {
  canonicalUrl: string;
  status: number;
  redirected: boolean;
  readableCharacters: number;
  sparse: boolean;
};

export type ProjectDomainSaveDiagnostic = {
  canonicalUrl: string;
  diagnostic: DomainDiagnostic | null;
  deferred: boolean;
  deferredReason: string | null;
};

export function canonicalizeProjectDomain(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Primary domain must be a valid absolute HTTPS URL.");
  }
  if (url.protocol !== "https:") throw new Error("Primary domain must be a valid absolute HTTPS URL.");
  if (url.username || url.password) throw new Error("Primary domain cannot include embedded credentials.");
  if (url.port && url.port !== "443") throw new Error("Primary domain must use the standard HTTPS port.");
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!hostname || isIP(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Primary domain must identify a public HTTPS hostname.");
  }
  return canonicalizeEvidenceUrl(url.toString());
}

function retrievalError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : "Unknown retrieval failure.";
  if (/valid absolute URL|Only HTTPS/iu.test(detail)) return new Error("Primary domain must be a valid absolute HTTPS URL.");
  if (/Private|unresolved|credentials|standard HTTPS port/iu.test(detail)) return new Error("Primary domain resolves to a private, reserved, or unsupported destination.");
  if (/redirect/iu.test(detail)) return new Error("Primary domain exceeded the safe redirect limit or returned an invalid redirect.");
  if (/timed out/iu.test(detail)) return new Error("Primary domain did not respond within 15 seconds.");
  if (/size limit/iu.test(detail)) return new Error("Primary domain returned more than 1,000,000 bytes.");
  return new Error("Primary domain could not be retrieved over verified HTTPS.");
}

export async function diagnoseProjectDomain(
  value: string,
  fetcher: typeof safeExternalFetch = safeExternalFetch,
): Promise<DomainDiagnostic> {
  let requested: URL;
  try {
    requested = new URL(value);
  } catch {
    throw new Error("Primary domain must be a valid absolute HTTPS URL.");
  }
  let response: Response;
  try {
    response = await fetcher(requested.toString(), {
      method: "GET",
      headers: {
        accept: "text/html,text/plain;q=0.9",
        "user-agent": "RefineStackSetupBot/1.0",
      },
    }, { timeoutMs: 15_000, maxBytes: 1_000_000, maxRedirects: 3 });
  } catch (error) {
    throw retrievalError(error);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Primary domain blocks automated retrieval with HTTP ${response.status}.`);
  }
  if (response.status === 429) throw new Error("Primary domain rate-limited the setup check with HTTP 429.");
  if (!response.ok) throw new Error(`Primary domain retrieval returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (contentType && contentType !== "text/html" && contentType !== "text/plain") {
    throw new Error(`Primary domain returned unsupported content type ${contentType}.`);
  }
  const body = await response.text();
  const readable = contentType === "text/html" ? htmlToText(body) : body.trim();
  const finalUrl = response.headers.get("x-refinestack-final-url") ?? requested.toString();
  const canonicalUrl = canonicalizeEvidenceUrl(finalUrl);
  return {
    canonicalUrl,
    status: response.status,
    redirected: canonicalUrl !== canonicalizeEvidenceUrl(requested.toString()),
    readableCharacters: readable.length,
    sparse: readable.length < 200 || (readable.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) < 30,
  };
}

export async function diagnoseProjectDomainForSave(
  value: string,
  fetcher: typeof safeExternalFetch = safeExternalFetch,
): Promise<ProjectDomainSaveDiagnostic> {
  const canonicalUrl = canonicalizeProjectDomain(value);
  try {
    const diagnostic = await diagnoseProjectDomain(canonicalUrl, fetcher);
    return {
      canonicalUrl: diagnostic.canonicalUrl,
      diagnostic,
      deferred: false,
      deferredReason: null,
    };
  } catch (error) {
    return {
      canonicalUrl,
      diagnostic: null,
      deferred: true,
      deferredReason: error instanceof Error ? error.message : "Primary domain verification could not be completed.",
    };
  }
}
