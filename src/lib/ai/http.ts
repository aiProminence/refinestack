import "server-only";
import type { ProviderKey } from "@/types/contracts";
import { redactSecrets } from "@/lib/security/secrets";
import { ProviderCaptureError } from "./types";

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export async function timedFetch(
  provider: ProviderKey,
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Provider request timed out", "TimeoutError"));
  }, Math.max(1, timeoutMs));

  try {
    const response = await fetcher(input, { ...init, signal: controller.signal });
    if (!response.ok) {
      let rawResponse: unknown;
      try {
        const text = await response.clone().text();
        rawResponse = text ? JSON.parse(text) : undefined;
      } catch {
        rawResponse = "Unreadable provider error response";
      }
      const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
      const details = {
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers),
        providerRequestId: requestId,
        rawResponse: redactSecrets(rawResponse),
      };
      if (response.status === 401 || response.status === 403) {
        throw new ProviderCaptureError(provider, "authentication", "Provider rejected the credential", details);
      }
      if (response.status === 429) {
        throw new ProviderCaptureError(provider, "rate_limited", "Provider rate limit exceeded", details);
      }
      if (response.status === 408 || response.status === 504) {
        throw new ProviderCaptureError(provider, "timeout", "Provider request timed out", details);
      }
      throw new ProviderCaptureError(provider, "provider_error", `Provider returned HTTP ${response.status}`, details);
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderCaptureError) throw error;
    const externalReason = externalSignal?.reason;
    const externallyTimedOut = externalSignal?.aborted
      && externalReason instanceof Error
      && externalReason.name === "TimeoutError";
    if (timedOut || externallyTimedOut || (error instanceof DOMException && error.name === "TimeoutError")) {
      throw new ProviderCaptureError(provider, "timeout", "Provider request timed out", { cause: error });
    }
    if (externalSignal?.aborted) {
      throw new ProviderCaptureError(provider, "unavailable", "Provider request was cancelled", { cause: error });
    }
    throw new ProviderCaptureError(provider, "provider_error", "Provider request failed", { cause: error });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

export async function parseJson(
  provider: ProviderKey,
  response: Response,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new ProviderCaptureError(provider, "malformed_response", "Provider returned invalid JSON", {
      status: response.status,
      cause,
    });
  }
}

export function uniqueCitations<T extends { url: string }>(citations: T[]): T[] {
  const seen = new Set<string>();
  return citations.filter(({ url }) => {
    let normalized: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
      if (parsed.username || parsed.password) return false;
      parsed.hash = "";
      normalized = parsed.toString();
    } catch {
      return false;
    }
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
