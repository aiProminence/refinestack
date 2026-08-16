import { z } from "zod";
import type { CitationInput, ProviderCaptureRequest, ProviderCaptureResult } from "@/types/contracts";
import { parseJson, timedFetch, uniqueCitations } from "../http";
import { redactSecrets } from "@/lib/security/secrets";
import { ProviderCaptureError, type FetchLike, type ProviderAdapter, validateCaptureRequest } from "../types";

const webUrl = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const referenceSchema = z.object({ link: webUrl.optional(), url: webUrl.optional(), title: z.string().optional() }).passthrough();
const textBlockSchema: z.ZodType<TextBlock> = z.lazy(() => z.object({
  type: z.string().optional(),
  snippet: z.string().optional(),
  text: z.string().optional(),
  list: z.array(z.union([z.string(), textBlockSchema])).optional(),
  items: z.array(z.union([z.string(), textBlockSchema])).optional(),
  reference_indexes: z.array(z.number().int().nonnegative()).optional(),
}).passthrough());
type TextBlock = {
  type?: string; snippet?: string; text?: string;
  list?: Array<string | TextBlock>; items?: Array<string | TextBlock>;
  reference_indexes?: number[];
};
const overviewSchema = z.object({
  page_token: z.string().optional(),
  text_blocks: z.array(textBlockSchema).optional(),
  references: z.array(referenceSchema).optional(),
}).passthrough();
const responseSchema = z.object({
  error: z.string().optional(),
  search_metadata: z.object({ id: z.string().optional(), status: z.string().optional() }).passthrough().optional(),
  ai_overview: overviewSchema.optional(),
}).passthrough();

function flattenBlocks(blocks: TextBlock[]): { text: string; indexes: number[] }[] {
  const output: { text: string; indexes: number[] }[] = [];
  const visit = (item: string | TextBlock, inherited: number[] = []) => {
    if (typeof item === "string") { if (item.trim()) output.push({ text: item.trim(), indexes: inherited }); return; }
    const indexes = item.reference_indexes ?? inherited;
    const value = item.snippet ?? item.text;
    if (value?.trim()) output.push({ text: value.trim(), indexes });
    item.list?.forEach((entry) => visit(entry, indexes));
    item.items?.forEach((entry) => visit(entry, indexes));
  };
  blocks.forEach((block) => visit(block));
  return output;
}

export type GoogleAIOverviewAdapterConfig = {
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  costPerSearchUsd?: number;
};

export function createGoogleAIOverviewAdapter(config: GoogleAIOverviewAdapterConfig): ProviderAdapter {
  return {
    key: "google_ai_overview",
    async capture(request: ProviderCaptureRequest, signal?: AbortSignal): Promise<ProviderCaptureResult> {
      if (!config.apiKey) throw new ProviderCaptureError("google_ai_overview", "unavailable", "SerpAPI key is not configured");
      request = validateCaptureRequest("google_ai_overview", request);
      const started = performance.now();
      const baseUrl = config.baseUrl ?? "https://serpapi.com/search.json";
      const initialUrl = new URL(baseUrl);
      const initialParams = new URLSearchParams({ engine: "google", q: request.prompt, api_key: config.apiKey,
        hl: request.locale.split(/[-_]/)[0].toLowerCase() });
      if (/^[a-z]{2}$/i.test(request.market)) initialParams.set("gl", request.market.toLowerCase());
      initialUrl.search = initialParams.toString();
      const requestCost = (count: number) => config.costPerSearchUsd === undefined
        ? undefined
        : count * config.costPerSearchUsd;
      let initialResponse: Response;
      let initialRaw: unknown;
      try {
        initialResponse = await timedFetch("google_ai_overview", config.fetch ?? fetch, initialUrl.toString(), { method: "GET" }, request.timeoutMs, signal);
        initialRaw = await parseJson("google_ai_overview", initialResponse);
      } catch (error) {
        if (!(error instanceof ProviderCaptureError)) throw error;
        throw new ProviderCaptureError(error.provider, error.code, error.message, {
          ...error.details,
          requestCount: 1,
          estimatedCostUsd: requestCost(1),
          rawResponse: redactSecrets({ initialFailure: error.details?.rawResponse, requestCount: 1 }),
          billingAmbiguous: true,
        });
      }
      const initial = responseSchema.safeParse(initialRaw);
      if (!initial.success) throw new ProviderCaptureError("google_ai_overview", "malformed_response", "SerpAPI Google response did not match its contract", { cause: initial.error, requestCount: 1, estimatedCostUsd: requestCost(1), rawResponse: redactSecrets({ initial: initialRaw, requestCount: 1 }), billingAmbiguous: false });
      if (initial.data.error) throw new ProviderCaptureError("google_ai_overview", /key|account|auth/i.test(initial.data.error) ? "authentication" : "provider_error", initial.data.error, { requestCount: 1, estimatedCostUsd: requestCost(1), providerRequestId: initial.data.search_metadata?.id, rawResponse: redactSecrets({ initial: initialRaw, requestCount: 1 }), billingAmbiguous: false });

      let overview = initial.data.ai_overview;
      let detailRaw: unknown;
      let requestCount = 1;
      if (overview?.page_token && !(overview.text_blocks?.length)) {
        const detailUrl = new URL(baseUrl);
        detailUrl.search = new URLSearchParams({ engine: "google_ai_overview", page_token: overview.page_token, api_key: config.apiKey }).toString();
        const elapsed = performance.now() - started;
        const remaining = request.timeoutMs - elapsed;
        if (remaining <= 0) throw new ProviderCaptureError("google_ai_overview", "timeout", "SerpAPI page token expired before detail retrieval", { requestCount: 1, estimatedCostUsd: requestCost(1), providerRequestId: initial.data.search_metadata?.id, rawResponse: redactSecrets({ initial: initialRaw, requestCount: 1 }), billingAmbiguous: false });
        let detailResponse: Response;
        try {
          detailResponse = await timedFetch("google_ai_overview", config.fetch ?? fetch, detailUrl.toString(), { method: "GET" }, remaining, signal);
          detailRaw = await parseJson("google_ai_overview", detailResponse);
        } catch (error) {
          if (!(error instanceof ProviderCaptureError)) throw error;
          throw new ProviderCaptureError(error.provider, error.code, error.message, {
            ...error.details,
            requestCount: 2,
            estimatedCostUsd: requestCost(2),
            providerRequestId: error.details?.providerRequestId ?? initial.data.search_metadata?.id,
            rawResponse: redactSecrets({ initial: initialRaw, detailFailure: error.details?.rawResponse, requestCount: 2 }),
            billingAmbiguous: true,
          });
        }
        const detail = responseSchema.safeParse(detailRaw);
        if (!detail.success) throw new ProviderCaptureError("google_ai_overview", "malformed_response", "SerpAPI AI Overview response did not match its contract", { cause: detail.error, requestCount: 2, estimatedCostUsd: requestCost(2), providerRequestId: initial.data.search_metadata?.id, rawResponse: redactSecrets({ initial: initialRaw, detail: detailRaw, requestCount: 2 }), billingAmbiguous: false });
        if (detail.data.error) throw new ProviderCaptureError("google_ai_overview", /key|account|auth/i.test(detail.data.error) ? "authentication" : /expired|unavailable/i.test(detail.data.error) ? "unavailable" : "provider_error", detail.data.error, { requestCount: 2, estimatedCostUsd: requestCost(2), providerRequestId: detail.data.search_metadata?.id ?? initial.data.search_metadata?.id, rawResponse: redactSecrets({ initial: initialRaw, detail: detailRaw, requestCount: 2 }), billingAmbiguous: false });
        overview = detail.data.ai_overview;
        requestCount = 2;
      }
      if (!overview) throw new ProviderCaptureError("google_ai_overview", "unavailable", "Google returned no AI Overview for this query", { requestCount, estimatedCostUsd: requestCost(requestCount), providerRequestId: initial.data.search_metadata?.id, rawResponse: redactSecrets({ initial: initialRaw, detail: detailRaw, requestCount }), billingAmbiguous: false });
      const flattened = flattenBlocks(overview.text_blocks ?? []);
      const answerText = flattened.map((entry) => entry.text).join("\n").trim();
      if (!answerText) throw new ProviderCaptureError("google_ai_overview", "malformed_response", "AI Overview contained no readable text blocks", { requestCount, estimatedCostUsd: requestCost(requestCount), providerRequestId: initial.data.search_metadata?.id, rawResponse: redactSecrets({ initial: initialRaw, detail: detailRaw, requestCount }), billingAmbiguous: false });
      const references = overview.references ?? [];
      const indexed = new Set(flattened.flatMap((entry) => entry.indexes));
      const selected = references.map((reference, index) => ({ reference, index })).filter(({ index }) => !indexed.size || indexed.has(index));
      const citations = uniqueCitations(selected.flatMap(({ reference, index }): CitationInput[] => {
        const url = reference.link ?? reference.url;
        return url ? [{ url, title: reference.title, position: index + 1 }] : [];
      }));
      return {
        provider: "google_ai_overview", accessMethod: "search_api", modelOrSurface: "Google AI Overview via SerpAPI",
        providerRequestId: initial.data.search_metadata?.id, answerText, citations,
        estimatedCostUsd: config.costPerSearchUsd === undefined ? undefined : requestCount * config.costPerSearchUsd,
        latencyMs: Math.max(0, Math.round(performance.now() - started)), capturedAt: new Date().toISOString(),
        rawResponse: redactSecrets({ initial: initialRaw, detail: detailRaw, requestCount }),
      };
    },
  };
}
import "server-only";
