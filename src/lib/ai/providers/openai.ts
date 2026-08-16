import { z } from "zod";
import type { ProviderCaptureRequest, ProviderCaptureResult } from "@/types/contracts";
import { parseJson, timedFetch, uniqueCitations } from "../http";
import {
  estimateTokenCost,
  ProviderCaptureError,
  type FetchLike,
  type ProviderAdapter,
  type TokenPricing, validateCaptureRequest,
} from "../types";

const webUrl = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const directCitationSchema = z.object({ type: z.literal("url_citation"), url: webUrl, title: z.string().optional(), start_index: z.number().int().nonnegative().optional() }).passthrough();
const nestedCitationSchema = z.object({
    type: z.literal("url_citation"),
    url_citation: z.object({ url: webUrl, title: z.string().optional(), start_index: z.number().int().nonnegative().optional() }).passthrough(),
  }).passthrough();
const contentSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  annotations: z.array(z.unknown()).optional(),
}).passthrough();
const sourceSchema = z.object({ url: webUrl, title: z.string().optional() }).passthrough();
const responseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(["completed", "failed", "incomplete", "in_progress", "queued", "cancelled"]).optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
  output_text: z.string().optional(),
  output: z.array(z.object({
    type: z.string().optional(),
    content: z.array(contentSchema).optional(),
    action: z.object({ sources: z.array(sourceSchema).optional() }).passthrough().optional(),
  }).passthrough()).optional(),
  usage: z.object({ input_tokens: z.number().int().nonnegative().optional(), output_tokens: z.number().int().nonnegative().optional() }).passthrough().optional(),
}).passthrough();

export type OpenAIAdapterConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  pricing?: TokenPricing;
  webSearch?: boolean;
  webSearchCostPerRequestUsd?: number;
};

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
export const DEFAULT_OPENAI_PRICING: TokenPricing = {
  inputPerMillionUsd: 0.2,
  outputPerMillionUsd: 1.2,
  source: "https://developers.openai.com/api/docs/models",
  effectiveAt: "2026-08-16",
};

export function createOpenAIAdapter(config: OpenAIAdapterConfig): ProviderAdapter {
  return {
    key: "openai",
    async capture(request: ProviderCaptureRequest, signal?: AbortSignal): Promise<ProviderCaptureResult> {
      if (!config.apiKey) throw new ProviderCaptureError("openai", "unavailable", "OpenAI API key is not configured");
      request = validateCaptureRequest("openai", request);
      const model = config.model ?? DEFAULT_OPENAI_MODEL;
      const started = performance.now();
      const response = await timedFetch("openai", config.fetch ?? fetch, `${config.baseUrl ?? "https://api.openai.com/v1"}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}`, "idempotency-key": request.jobId, "x-client-request-id": request.jobId },
        body: JSON.stringify({
          model,
          max_output_tokens: 2048,
          input: [
            { role: "developer", content: [{ type: "input_text", text: `Answer for market ${request.market} and use language/locale ${request.locale}. Keep market and language constraints distinct.` }] },
            { role: "user", content: [{ type: "input_text", text: request.prompt }] },
          ],
          ...(config.webSearch === false ? {} : { tools: [{ type: "web_search", ...(/^[a-z]{2}$/iu.test(request.market) ? { user_location: { type: "approximate", country: request.market.toUpperCase() } } : {}) }], include: ["web_search_call.action.sources"] }),
        }),
      }, request.timeoutMs, signal);
      const raw = await parseJson("openai", response);
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderCaptureError("openai", "malformed_response", "OpenAI response did not match the Responses API contract", { status: response.status, cause: parsed.error, requestCount: 1, rawResponse: raw, billingAmbiguous: true });
      const inputTokens = parsed.data.usage?.input_tokens;
      const outputTokens = parsed.data.usage?.output_tokens;
      const searchCalls = parsed.data.output?.filter((item) => item.type === "web_search_call").length ?? 0;
      const tokenCost = estimateTokenCost(inputTokens, outputTokens, config.pricing ?? DEFAULT_OPENAI_PRICING);
      const searchCost = searchCalls * (config.webSearchCostPerRequestUsd ?? 0.01);
      const usageDetails = { requestCount: 1, inputTokens, outputTokens, searchRequests: searchCalls, estimatedCostUsd: tokenCost === undefined ? (searchCalls ? searchCost : undefined) : tokenCost + searchCost };
      if (parsed.data.status && parsed.data.status !== "completed") throw new ProviderCaptureError("openai", "malformed_response", `OpenAI response was ${parsed.data.status}${parsed.data.incomplete_details?.reason ? `: ${parsed.data.incomplete_details.reason}` : ""}`, { status: response.status, rawResponse: raw, ...usageDetails });
      const content = parsed.data.output?.flatMap((item) => item.content ?? []) ?? [];
      const answerText = content.filter((item) => item.type === "output_text" && item.text).map((item) => item.text).join("\n").trim() || parsed.data.output_text?.trim() || "";
      if (!answerText) throw new ProviderCaptureError("openai", "malformed_response", "OpenAI response contained no output text", { status: response.status, rawResponse: raw, billingAmbiguous: false, ...usageDetails });
      const inlineCitations = content.flatMap((item) => (item.annotations ?? []).flatMap((annotation) => {
        const direct = directCitationSchema.safeParse(annotation);
        if (direct.success) return [{ url: direct.data.url, title: direct.data.title, position: direct.data.start_index }];
        const nested = nestedCitationSchema.safeParse(annotation);
        return nested.success ? [{ url: nested.data.url_citation.url, title: nested.data.url_citation.title, position: nested.data.url_citation.start_index }] : [];
      }));
      const sourceCitations = parsed.data.output?.flatMap((item) => item.action?.sources ?? []).map(({ url, title }) => ({ url, title })) ?? [];
      const citations = uniqueCitations([...inlineCitations, ...sourceCitations]);
      return {
        provider: "openai", accessMethod: "api", modelOrSurface: parsed.data.model ?? model,
        providerRequestId: parsed.data.id ?? response.headers.get("x-request-id") ?? undefined,
        answerText, citations, inputTokens, outputTokens,
        estimatedCostUsd: tokenCost === undefined ? (searchCalls ? searchCost : undefined) : tokenCost + searchCost,
        latencyMs: Math.max(0, Math.round(performance.now() - started)), capturedAt: new Date().toISOString(), rawResponse: raw,
      };
    },
  };
}
import "server-only";
