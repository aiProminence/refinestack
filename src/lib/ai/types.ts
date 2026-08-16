import type {
  ProviderCaptureRequest,
  ProviderCaptureResult,
  ProviderFailureCode,
  ProviderKey,
} from "@/types/contracts";

export type FetchLike = typeof fetch;

const captureRequestSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128),
  projectId: z.string().trim().min(1).max(128),
  runId: z.string().trim().min(1).max(128),
  jobId: z.string().trim().min(1).max(128),
  questionId: z.string().trim().min(1).max(128),
  prompt: z.string().trim().min(1).max(100_000),
  locale: z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/u),
  market: z.string().trim().min(2).max(64),
  timeoutMs: z.number().finite().int().min(100).max(120_000),
}).strict();

export function validateCaptureRequest(provider: ProviderKey, request: ProviderCaptureRequest) {
  const parsed = captureRequestSchema.safeParse(request);
  if (!parsed.success) throw new ProviderCaptureError(provider, "malformed_response", "Capture request is invalid", { cause: parsed.error });
  return parsed.data;
}

export type TokenPricing = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  source: string;
  effectiveAt: string;
};

export type ProviderAdapter = {
  readonly key: ProviderKey;
  capture(request: ProviderCaptureRequest, signal?: AbortSignal): Promise<ProviderCaptureResult>;
};

export class ProviderCaptureError extends Error {
  readonly name = "ProviderCaptureError";

  constructor(
    public readonly provider: ProviderKey,
    public readonly code: ProviderFailureCode,
    message: string,
    public readonly details?: {
      status?: number;
      retryAfterMs?: number;
      providerRequestId?: string;
      rawResponse?: unknown;
      cause?: unknown;
      requestCount?: number;
      inputTokens?: number;
      outputTokens?: number;
      searchRequests?: number;
      estimatedCostUsd?: number;
      billingAmbiguous?: boolean;
    },
  ) {
    super(message);
  }
}

export function estimateTokenCost(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  pricing: TokenPricing | undefined,
): number | undefined {
  if (!pricing || inputTokens === undefined || outputTokens === undefined) return undefined;
  return (
    (inputTokens * pricing.inputPerMillionUsd + outputTokens * pricing.outputPerMillionUsd) /
    1_000_000
  );
}
import { z } from "zod";
