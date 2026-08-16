import { describe, expect, it, vi } from "vitest";
import { completeJob, failJob, type ProductDbClient } from "@/lib/db";

const clientWithRpc = (rpc: ReturnType<typeof vi.fn>) => ({ rpc }) as unknown as ProductDbClient;

describe("worker persistence RPC envelope", () => {
  it("passes complete usage and request timing without hard-coded defaults", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "observation-id", error: null });
    await completeJob({
      client: clientWithRpc(rpc), jobId: "job", workerId: "worker", accessMethod: "api",
      modelOrSurface: "model", exactPrompt: "prompt", providerRequestId: "request",
      requestedAt: "2026-08-16T00:00:00.000Z", capturedAt: "2026-08-16T00:00:01.000Z", latencyMs: 1000,
      usage: { callCount: 3, searchRequests: 2, inputTokens: 41, outputTokens: 17, estimatedCostUsd: 0.123456, usageComplete: true, billingAmbiguous: false },
      rawResponse: { exact: true }, answerText: "answer", citations: [], classifications: [],
      classifier: { name: "classifier", version: "1", inputHash: "hash" },
    });
    expect(rpc).toHaveBeenCalledWith("complete_capture_job_v2", expect.objectContaining({
      p_call_count: 3, p_search_requests: 2, p_input_tokens: 41, p_output_tokens: 17,
      p_estimated_cost_usd: 0.123456, p_usage_complete: true, p_billing_ambiguous: false,
      p_requested_at: "2026-08-16T00:00:00.000Z",
    }));
  });

  it("passes exact failure usage, raw response, and retry boundary", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "queued", error: null });
    await failJob({
      client: clientWithRpc(rpc), jobId: "job", workerId: "worker", status: "failed", accessMethod: "search_api",
      modelOrSurface: "surface", exactPrompt: "prompt", requestedAt: "2026-08-16T00:00:00.000Z",
      capturedAt: "2026-08-16T00:00:02.000Z", latencyMs: 2000, errorCode: "rate_limited",
      errorMessage: "limited", retryable: true, retryAt: "2026-08-16T00:01:00.000Z",
      usage: { callCount: 2, searchRequests: 2, estimatedCostUsd: 0.02, usageComplete: true, billingAmbiguous: false },
      rawResponse: { status: 429 },
    });
    expect(rpc).toHaveBeenCalledWith("fail_capture_job_v2", expect.objectContaining({
      p_call_count: 2, p_search_requests: 2, p_estimated_cost_usd: 0.02,
      p_retry_at: "2026-08-16T00:01:00.000Z", p_raw_response: { status: 429 },
    }));
  });
});
