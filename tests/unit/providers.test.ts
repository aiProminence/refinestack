import { describe, expect, it, vi } from "vitest";
import { captureProvider, createAnthropicAdapter, createGoogleAIOverviewAdapter, createOpenAIAdapter, ProviderCaptureError, type ProviderAdapter } from "@/lib/ai";
import type { ProviderCaptureRequest } from "@/types/contracts";

const request: ProviderCaptureRequest = { workspaceId: "w", projectId: "p", runId: "r", jobId: "j", questionId: "q", prompt: "Which tools are best?", locale: "en-US", market: "us", timeoutMs: 1000 };
const json = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("provider adapters", () => {
  it("extracts OpenAI text, citations, usage, cost, and request provenance", async () => {
    const fetcher = vi.fn(async () => json({ id: "resp_1", model: "gpt-x", output: [{ type: "message", content: [{ type: "output_text", text: "Use Alpha.", annotations: [{ type: "url_citation", url: "https://example.com/a", title: "A" }] }] }], usage: { input_tokens: 100, output_tokens: 50 } }));
    const result = await createOpenAIAdapter({ apiKey: "secret", model: "gpt-x", fetch: fetcher as typeof fetch, pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 8, source: "test", effectiveAt: "2026-01-01" } }).capture(request);
    expect(result).toMatchObject({ provider: "openai", answerText: "Use Alpha.", providerRequestId: "resp_1", inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.0006 });
    expect(result.citations).toEqual([{ url: "https://example.com/a", title: "A" }]);
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toMatchObject({ model: "gpt-x", tools: [{ type: "web_search" }] });
    expect(new Headers(call[1].headers).get("idempotency-key")).toBe("j");
  });

  it("extracts OpenAI source URLs and accounts for actual web-search calls", async () => {
    const fetcher = vi.fn(async () => json({ id: "resp_2", output: [{ type: "web_search_call", action: { sources: [{ url: "https://source.test", title: "Source" }] } }, { type: "message", content: [{ type: "output_text", text: "Answer" }] }], usage: { input_tokens: 100, output_tokens: 50 } }));
    const result = await createOpenAIAdapter({ apiKey: "x", model: "m", fetch: fetcher as typeof fetch, pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 8, source: "test", effectiveAt: "2026-01-01" } }).capture(request);
    expect(result.citations).toEqual([{ url: "https://source.test", title: "Source" }]);
    expect(result.estimatedCostUsd).toBeCloseTo(0.0106);
  });

  it.each([[401, "authentication"], [403, "authentication"], [429, "rate_limited"], [504, "timeout"], [500, "provider_error"]] as const)("maps HTTP %i to %s", async (status, code) => {
    const adapter = createOpenAIAdapter({ apiKey: "x", model: "m", fetch: vi.fn(async () => json({}, status)) as typeof fetch });
    await expect(adapter.capture(request)).rejects.toMatchObject({ code, provider: "openai" });
  });

  it("rejects absent credentials and malformed bodies without a fallback", async () => {
    await expect(createOpenAIAdapter({ model: "m" }).capture(request)).rejects.toMatchObject({ code: "unavailable" });
    await expect(createOpenAIAdapter({ apiKey: "x", model: "m", fetch: vi.fn(async () => json({ output: [] })) as typeof fetch }).capture(request)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("rejects incomplete OpenAI responses while retaining billable usage", async () => {
    const fetcher = vi.fn(async () => json({ id: "resp", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ type: "output_text", text: "Partial" }] }], usage: { input_tokens: 10, output_tokens: 5 } }));
    const outcome = await captureProvider({ provider: "openai", adapter: createOpenAIAdapter({ apiKey: "x", model: "m", fetch: fetcher as typeof fetch }), request });
    expect(outcome).toMatchObject({ ok: false, failure: { code: "malformed_response", usage: { requestCount: 1, inputTokens: 10, outputTokens: 5, ambiguousBilling: false } } });
  });

  it("retains raw response and billable usage when OpenAI returns no output text", async () => {
    const raw = { id: "resp_empty", status: "completed", output: [], usage: { input_tokens: 12, output_tokens: 0 } };
    const outcome = await captureProvider({ provider: "openai", adapter: createOpenAIAdapter({ apiKey: "x", model: "m", fetch: vi.fn(async () => json(raw)) as typeof fetch }), request });
    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        code: "malformed_response",
        rawResponse: raw,
        usage: { requestCount: 1, inputTokens: 12, outputTokens: 0, searchRequests: 0, ambiguousBilling: false },
      },
    });
  });

  it("drops non-web citation schemes", async () => {
    const fetcher = vi.fn(async () => json({ id: "resp", output: [{ type: "message", content: [{ type: "output_text", text: "Answer", annotations: [{ type: "url_citation", url: "javascript:alert(1)" }, { type: "url_citation", url: "https://safe.test" }] }] }] }));
    const result = await createOpenAIAdapter({ apiKey: "x", model: "m", fetch: fetcher as typeof fetch }).capture(request);
    expect(result.citations).toEqual([{ url: "https://safe.test", title: undefined, position: undefined }]);
  });

  it("extracts Anthropic citation and search usage", async () => {
    const fetcher = vi.fn(async () => json({ id: "msg_1", model: "claude-x", content: [{ type: "text", text: "Alpha is recommended.", citations: [{ type: "web_search_result_location", url: "https://source.test", title: "Source", cited_text: "proof" }] }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 10, server_tool_use: { web_search_requests: 2 } } }));
    const result = await createAnthropicAdapter({ apiKey: "x", model: "claude-x", fetch: fetcher as typeof fetch, webSearchCostPerRequestUsd: 0.01 }).capture(request);
    expect(result.citations).toEqual([{ url: "https://source.test", title: "Source" }]);
    expect(result.estimatedCostUsd).toBe(0.02);
  });

  it("maps Anthropic in-band web-search failures", async () => {
    const fetcher = vi.fn(async () => json({ id: "msg", content: [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } }] }));
    await expect(createAnthropicAdapter({ apiKey: "x", model: "m", fetch: fetcher as typeof fetch }).capture(request)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("continues an Anthropic pause_turn without restarting the user request", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ id: "pause", stop_reason: "pause_turn", content: [{ type: "text", text: "Working" }], usage: { input_tokens: 4, output_tokens: 2 } }))
      .mockResolvedValueOnce(json({ id: "final", stop_reason: "end_turn", content: [{ type: "text", text: "Final answer" }], usage: { input_tokens: 3, output_tokens: 2 } }));
    const result = await createAnthropicAdapter({ apiKey: "x", model: "m", fetch: fetcher as typeof fetch, pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1, source: "test", effectiveAt: "now" } }).capture(request);
    expect(result).toMatchObject({ answerText: "Final answer", inputTokens: 7, outputTokens: 4 });
    const secondBody = JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(secondBody.messages[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Working" }] });
  });

  it("preserves completed Anthropic turns when a continuation request fails", async () => {
    const first = { id: "pause", stop_reason: "pause_turn", content: [{ type: "text", text: "Working" }], usage: { input_tokens: 4, output_tokens: 2, server_tool_use: { web_search_requests: 1 } } };
    const secondFailure = { type: "error", error: { message: "upstream unavailable" } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json(secondFailure, 503));
    const outcome = await captureProvider({
      provider: "claude",
      adapter: createAnthropicAdapter({ apiKey: "x", model: "m", fetch: fetcher as typeof fetch, pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1, source: "test", effectiveAt: "now" }, webSearchCostPerRequestUsd: 0.01 }),
      request,
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        code: "provider_error",
        rawResponse: { turns: [first], failure: secondFailure, requestCount: 2 },
        usage: { requestCount: 2, inputTokens: 4, outputTokens: 2, searchRequests: 1, ambiguousBilling: true },
      },
    });
    if (!outcome.ok) expect(outcome.failure.usage.estimatedCostUsd).toBeCloseTo(0.010006);
  });

  it("follows a SerpAPI page token, extracts referenced sources, and redacts credentials", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ search_metadata: { id: "search_1" }, ai_overview: { page_token: "token" } }))
      .mockResolvedValueOnce(json({ ai_overview: { text_blocks: [{ type: "paragraph", snippet: "Alpha is useful.", reference_indexes: [0] }, { type: "list", list: ["Fast", { text: "Safe", reference_indexes: [1] }] }], references: [{ link: "https://a.test", title: "A" }, { url: "https://b.test", title: "B" }] } }));
    const result = await createGoogleAIOverviewAdapter({ apiKey: "top-secret", fetch: fetcher as typeof fetch, costPerSearchUsd: 0.005 }).capture(request);
    expect(result.answerText).toBe("Alpha is useful.\nFast\nSafe");
    expect(result.citations.map(({ url }) => url)).toEqual(["https://a.test", "https://b.test"]);
    expect(result.estimatedCostUsd).toBe(0.01);
    expect(JSON.stringify(result.rawResponse)).not.toContain("top-secret");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves both Google request costs and raw details when detail retrieval fails", async () => {
    const initial = { search_metadata: { id: "search_1" }, ai_overview: { page_token: "token" } };
    const detailFailure = { error: "upstream failed" };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(initial))
      .mockResolvedValueOnce(json(detailFailure, 503));
    const outcome = await captureProvider({ provider: "google_ai_overview", adapter: createGoogleAIOverviewAdapter({ apiKey: "top-secret", fetch: fetcher as typeof fetch, costPerSearchUsd: 0.005 }), request });
    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        providerRequestId: "search_1",
        rawResponse: { initial: { ...initial, ai_overview: { page_token: "[redacted]" } }, detailFailure, requestCount: 2 },
        usage: { requestCount: 2, estimatedCostUsd: 0.01, ambiguousBilling: true },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("top-secret");
  });

  it("reports a missing AI Overview as unavailable", async () => {
    const adapter = createGoogleAIOverviewAdapter({ apiKey: "x", fetch: vi.fn(async () => json({ organic_results: [] })) as typeof fetch });
    await expect(adapter.capture(request)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("uses a typed timeout and never returns synthetic data", async () => {
    const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const adapter = createOpenAIAdapter({ apiKey: "x", model: "m", fetch: fetcher as typeof fetch });
    await expect(adapter.capture({ ...request, timeoutMs: 100 })).rejects.toSatisfy((error: unknown) => error instanceof ProviderCaptureError && error.code === "timeout");
  });

  it("preserves an external worker deadline as a retryable provider timeout", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const outcomePromise = captureProvider({ provider: "openai", adapter: createOpenAIAdapter({ apiKey: "x", model: "m", fetch: fetcher as typeof fetch }), request, signal: controller.signal });
    controller.abort(new DOMException("worker deadline", "TimeoutError"));
    await expect(outcomePromise).resolves.toMatchObject({ ok: false, failure: { code: "timeout", retryable: true } });
  });

  it("dispatches exactly one named provider and returns a retryable failure envelope", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "x", model: "m", fetch: vi.fn(async () => json({}, 429, { "retry-after": "2" })) as typeof fetch });
    const outcome = await captureProvider({ provider: "openai", adapter, request });
    expect(outcome).toEqual({ ok: false, failure: expect.objectContaining({ provider: "openai", code: "rate_limited", retryable: true, retryAfterMs: 2000 }) });
    const mismatch = await captureProvider({ provider: "claude", adapter, request });
    expect(mismatch).toEqual({ ok: false, failure: expect.objectContaining({ code: "provider_error", retryable: false }) });
  });

  it("returns normalized success usage and provenance from the runtime boundary", async () => {
    const adapter: ProviderAdapter = { key: "openai", capture: vi.fn(async () => ({ provider: "openai" as const, accessMethod: "api" as const, modelOrSurface: "m", answerText: "answer", citations: [], inputTokens: 4, outputTokens: 2, estimatedCostUsd: 0.01, latencyMs: 12, capturedAt: "2026-01-01T00:00:00.000Z", rawResponse: { output: [{ type: "web_search_call" }] } })) };
    await expect(captureProvider({ provider: "openai", adapter, request })).resolves.toMatchObject({ ok: true, usage: { inputTokens: 4, outputTokens: 2, searchRequests: 1, estimatedCostUsd: 0.01 }, provenance: { modelOrSurface: "m", latencyMs: 12 } });
  });

  it("normalizes unexpected adapter errors with ambiguous attempt usage", async () => {
    const adapter: ProviderAdapter = { key: "openai", capture: vi.fn(async () => { throw new Error("socket reset"); }) };
    await expect(captureProvider({ provider: "openai", adapter, request })).resolves.toMatchObject({ ok: false, failure: { code: "provider_error", retryable: true, usage: { requestCount: 1, ambiguousBilling: true } } });
  });
});
