import "server-only";
import { z } from "zod";
import type { ProviderCaptureRequest, ProviderCaptureResult } from "@/types/contracts";
import { parseJson, timedFetch, uniqueCitations } from "../http";
import { estimateTokenCost, ProviderCaptureError, type FetchLike, type ProviderAdapter, type TokenPricing, validateCaptureRequest } from "../types";

const webUrl = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const citationSchema = z.object({ type: z.literal("web_search_result_location"), url: webUrl, title: z.string().optional(), cited_text: z.string().optional() }).passthrough();
const contentBlockSchema = z.object({
  type: z.string(), text: z.string().optional(), citations: z.array(citationSchema).optional(),
  content: z.union([z.array(z.unknown()), z.object({ type: z.string(), error_code: z.string().optional() }).passthrough()]).optional(),
}).passthrough();
const responseSchema = z.object({
  id: z.string(), model: z.string().optional(), stop_reason: z.string().nullable().optional(), content: z.array(contentBlockSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative().optional(), output_tokens: z.number().int().nonnegative().optional(), server_tool_use: z.object({ web_search_requests: z.number().int().nonnegative().optional() }).passthrough().optional() }).passthrough().optional(),
}).passthrough();

export type AnthropicAdapterConfig = {
  apiKey?: string; model: string; maxTokens?: number; maxSearches?: number; maxContinuations?: number;
  baseUrl?: string; fetch?: FetchLike; pricing?: TokenPricing; webSearchCostPerRequestUsd?: number;
};

export function createAnthropicAdapter(config: AnthropicAdapterConfig): ProviderAdapter {
  return {
    key: "claude",
    async capture(request: ProviderCaptureRequest, signal?: AbortSignal): Promise<ProviderCaptureResult> {
      if (!config.apiKey) throw new ProviderCaptureError("claude", "unavailable", "Anthropic API key is not configured");
      request = validateCaptureRequest("claude", request);
      const started = performance.now();
      const country = /^[a-z]{2}$/iu.test(request.market) ? request.market.toUpperCase() : undefined;
      const messages: unknown[] = [{ role: "user", content: request.prompt }];
      const rawTurns: unknown[] = [];
      let totalInput = 0; let totalOutput = 0; let totalSearches = 0; let parsedFinal: z.infer<typeof responseSchema> | undefined;
      const maxContinuations = config.maxContinuations ?? 2;
      if (!Number.isSafeInteger(maxContinuations) || maxContinuations < 0 || maxContinuations > 5) throw new ProviderCaptureError("claude", "malformed_response", "Anthropic continuation limit is invalid", { requestCount: 0 });

      const accumulatedCost = () => {
        const tokenCost = estimateTokenCost(totalInput, totalOutput, config.pricing);
        const searchCost = config.webSearchCostPerRequestUsd === undefined
          ? undefined
          : totalSearches * config.webSearchCostPerRequestUsd;
        return tokenCost === undefined && searchCost === undefined
          ? undefined
          : (tokenCost ?? 0) + (searchCost ?? 0);
      };
      const accumulatedRaw = (requestCount: number, failure?: unknown) => ({
        turns: rawTurns,
        ...(failure === undefined ? {} : { failure }),
        requestCount,
      });
      const rethrowTransportFailure = (error: unknown): never => {
        if (!(error instanceof ProviderCaptureError)) throw error;
        const requestCount = Math.max(rawTurns.length + 1, error.details?.requestCount ?? 0);
        throw new ProviderCaptureError(error.provider, error.code, error.message, {
          ...error.details,
          requestCount,
          inputTokens: rawTurns.length > 0 ? totalInput : error.details?.inputTokens,
          outputTokens: rawTurns.length > 0 ? totalOutput : error.details?.outputTokens,
          searchRequests: rawTurns.length > 0 ? totalSearches : error.details?.searchRequests,
          estimatedCostUsd: rawTurns.length > 0 ? accumulatedCost() : error.details?.estimatedCostUsd,
          rawResponse: accumulatedRaw(requestCount, error.details?.rawResponse),
          billingAmbiguous: true,
        });
      };

      for (let turn = 0; turn <= maxContinuations; turn += 1) {
        const remaining = request.timeoutMs - (performance.now() - started);
        if (remaining <= 0) throw new ProviderCaptureError("claude", "timeout", "Anthropic continuation exceeded the capture deadline", {
          requestCount: rawTurns.length,
          inputTokens: totalInput,
          outputTokens: totalOutput,
          searchRequests: totalSearches,
          estimatedCostUsd: accumulatedCost(),
          rawResponse: accumulatedRaw(rawTurns.length),
          billingAmbiguous: false,
        });
        let response!: Response;
        let raw: unknown;
        try {
          response = await timedFetch("claude", config.fetch ?? fetch, `${config.baseUrl ?? "https://api.anthropic.com/v1"}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", "x-client-request-id": request.jobId },
            body: JSON.stringify({
              model: config.model, max_tokens: config.maxTokens ?? 2048,
              system: `Answer in language/locale ${request.locale} for market ${request.market}. Keep the language and market constraints distinct.`,
              messages,
              tools: [{ type: "web_search_20250305", name: "web_search", max_uses: config.maxSearches ?? 5, ...(country ? { user_location: { type: "approximate", country } } : {}) }],
            }),
          }, remaining, signal);
          raw = await parseJson("claude", response);
        } catch (error) {
          rethrowTransportFailure(error);
        }
        rawTurns.push(raw);
        const parsed = responseSchema.safeParse(raw);
        if (!parsed.success) throw new ProviderCaptureError("claude", "malformed_response", "Anthropic response did not match the Messages API contract", {
          status: response.status,
          cause: parsed.error,
          requestCount: rawTurns.length,
          inputTokens: totalInput,
          outputTokens: totalOutput,
          searchRequests: totalSearches,
          estimatedCostUsd: accumulatedCost(),
          rawResponse: accumulatedRaw(rawTurns.length),
          billingAmbiguous: true,
        });
        totalInput += parsed.data.usage?.input_tokens ?? 0;
        totalOutput += parsed.data.usage?.output_tokens ?? 0;
        totalSearches += parsed.data.usage?.server_tool_use?.web_search_requests ?? 0;
        const usageDetails = {
          requestCount: rawTurns.length,
          inputTokens: totalInput,
          outputTokens: totalOutput,
          searchRequests: totalSearches,
          estimatedCostUsd: accumulatedCost(),
          rawResponse: accumulatedRaw(rawTurns.length),
          billingAmbiguous: false,
        };
        for (const block of parsed.data.content) {
          if (block.type !== "web_search_tool_result" || !block.content || Array.isArray(block.content)) continue;
          const code = block.content.error_code;
          if (code === "too_many_requests") throw new ProviderCaptureError("claude", "rate_limited", "Anthropic web search rate limit exceeded", usageDetails);
          if (code === "unavailable") throw new ProviderCaptureError("claude", "unavailable", "Anthropic web search is unavailable", usageDetails);
          throw new ProviderCaptureError("claude", "provider_error", `Anthropic web search failed: ${code ?? "unknown error"}`, { ...usageDetails, status: 400 });
        }
        if (parsed.data.stop_reason === "pause_turn") {
          if (turn === maxContinuations) throw new ProviderCaptureError("claude", "provider_error", "Anthropic exceeded the continuation limit", usageDetails);
          messages.push({ role: "assistant", content: (raw as { content: unknown }).content });
          continue;
        }
        if (parsed.data.stop_reason === "max_tokens") throw new ProviderCaptureError("claude", "malformed_response", "Anthropic response was truncated at the output-token limit", usageDetails);
        parsedFinal = parsed.data;
        break;
      }
      if (!parsedFinal) throw new ProviderCaptureError("claude", "provider_error", "Anthropic did not return a final turn", { requestCount: rawTurns.length, inputTokens: totalInput, outputTokens: totalOutput, searchRequests: totalSearches, estimatedCostUsd: accumulatedCost(), rawResponse: accumulatedRaw(rawTurns.length), billingAmbiguous: false });
      const answerText = parsedFinal.content.filter((block) => block.type === "text" && block.text).map((block) => block.text).join("\n").trim();
      if (!answerText) throw new ProviderCaptureError("claude", "malformed_response", "Anthropic response contained no final text", { requestCount: rawTurns.length, inputTokens: totalInput, outputTokens: totalOutput, searchRequests: totalSearches, estimatedCostUsd: accumulatedCost(), rawResponse: accumulatedRaw(rawTurns.length), billingAmbiguous: false });
      const citations = uniqueCitations(parsedFinal.content.flatMap((block) => (block.citations ?? []).map((citation) => ({ url: citation.url, title: citation.title }))));
      const estimatedCostUsd = accumulatedCost();
      const rawResponse = rawTurns.length === 1 ? rawTurns[0] : { turns: rawTurns, usage: { input_tokens: totalInput, output_tokens: totalOutput, server_tool_use: { web_search_requests: totalSearches } }, requestCount: rawTurns.length };
      return { provider: "claude", accessMethod: "api", modelOrSurface: parsedFinal.model ?? config.model, providerRequestId: parsedFinal.id, answerText, citations, inputTokens: totalInput, outputTokens: totalOutput, estimatedCostUsd, latencyMs: Math.max(0, Math.round(performance.now() - started)), capturedAt: new Date().toISOString(), rawResponse };
    },
  };
}
