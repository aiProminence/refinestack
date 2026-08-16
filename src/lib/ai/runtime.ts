import type { ProviderCaptureRequest, ProviderCaptureResult, ProviderFailureCode, ProviderKey } from "@/types/contracts";
import { ProviderCaptureError, type ProviderAdapter } from "./types";

export type CaptureProviderInput = {
  provider: ProviderKey;
  adapter: ProviderAdapter;
  request: ProviderCaptureRequest;
  signal?: AbortSignal;
};
export type CaptureUsage = {
  inputTokens?: number;
  outputTokens?: number;
  searchRequests?: number;
  estimatedCostUsd?: number;
  costMethod: "configured_estimate" | "unavailable";
};
export type CaptureFailure = {
  provider: ProviderKey;
  code: ProviderFailureCode;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  providerRequestId?: string;
  rawResponse?: unknown;
  usage: CaptureUsage & { requestCount: number; ambiguousBilling: boolean };
};
export type CaptureProviderOutcome =
  | { ok: true; result: ProviderCaptureResult; usage: CaptureUsage; provenance: { accessMethod: ProviderCaptureResult["accessMethod"]; modelOrSurface: string; providerRequestId?: string; capturedAt: string; latencyMs: number } }
  | { ok: false; failure: CaptureFailure };

function searchRequests(result: ProviderCaptureResult): number | undefined {
  const raw = result.rawResponse;
  if (!raw || typeof raw !== "object") return undefined;
  const object = raw as Record<string, unknown>;
  if (result.provider === "google_ai_overview" && typeof object.requestCount === "number") return object.requestCount;
  if (result.provider === "claude") {
    const usage = object.usage as Record<string, unknown> | undefined;
    const server = usage?.server_tool_use as Record<string, unknown> | undefined;
    return typeof server?.web_search_requests === "number" ? server.web_search_requests : undefined;
  }
  if (result.provider === "openai" && Array.isArray(object.output)) {
    return object.output.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "web_search_call").length;
  }
  return undefined;
}

function retryable(code: ProviderFailureCode, status?: number): boolean {
  return code === "rate_limited" || code === "timeout" || (code === "provider_error" && (status === undefined || status >= 500));
}

/** Pure orchestration boundary: invokes exactly the requested adapter and never persists or fails over. */
export async function captureProvider(input: CaptureProviderInput): Promise<CaptureProviderOutcome> {
  if (input.adapter.key !== input.provider) {
    return { ok: false, failure: { provider: input.provider, code: "provider_error", message: `Adapter ${input.adapter.key} cannot capture ${input.provider}`, retryable: false, usage: { requestCount: 0, costMethod: "unavailable", ambiguousBilling: false } } };
  }
  try {
    const result = await input.adapter.capture(input.request, input.signal);
    if (result.provider !== input.provider) {
      return { ok: false, failure: { provider: input.provider, code: "malformed_response", message: "Adapter returned a different provider identity", retryable: false, rawResponse: result.rawResponse, usage: { requestCount: 1, inputTokens: result.inputTokens, outputTokens: result.outputTokens, searchRequests: searchRequests(result), estimatedCostUsd: result.estimatedCostUsd, costMethod: result.estimatedCostUsd === undefined ? "unavailable" : "configured_estimate", ambiguousBilling: false } } };
    }
    return {
      ok: true,
      result,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, searchRequests: searchRequests(result), estimatedCostUsd: result.estimatedCostUsd, costMethod: result.estimatedCostUsd === undefined ? "unavailable" : "configured_estimate" },
      provenance: { accessMethod: result.accessMethod, modelOrSurface: result.modelOrSurface, providerRequestId: result.providerRequestId, capturedAt: result.capturedAt, latencyMs: result.latencyMs },
    };
  } catch (error) {
    const failure = error instanceof ProviderCaptureError ? error : new ProviderCaptureError(input.provider, "provider_error", "Unexpected provider adapter failure", { cause: error });
    const requestCount = failure.details?.requestCount ?? (failure.code === "unavailable" && failure.details?.status === undefined ? 0 : 1);
    return { ok: false, failure: { provider: input.provider, code: failure.code, message: failure.message, retryable: retryable(failure.code, failure.details?.status), status: failure.details?.status, retryAfterMs: failure.details?.retryAfterMs, providerRequestId: failure.details?.providerRequestId, rawResponse: failure.details?.rawResponse, usage: { requestCount, inputTokens: failure.details?.inputTokens, outputTokens: failure.details?.outputTokens, searchRequests: failure.details?.searchRequests, estimatedCostUsd: failure.details?.estimatedCostUsd, costMethod: failure.details?.estimatedCostUsd === undefined ? "unavailable" : "configured_estimate", ambiguousBilling: failure.details?.billingAmbiguous ?? (requestCount > 0 && failure.details?.inputTokens === undefined && failure.details?.estimatedCostUsd === undefined) } } };
  }
}
import "server-only";
