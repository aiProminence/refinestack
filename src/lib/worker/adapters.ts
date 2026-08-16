import "server-only";
import type { ProviderKey } from "@/types/contracts";
import { createAnthropicAdapter, createGoogleAIOverviewAdapter, createOpenAIAdapter, type ProviderAdapter, type TokenPricing } from "@/lib/ai";
import type { Json } from "@/types/database";

export class WorkerConfigurationError extends Error { readonly name = "WorkerConfigurationError"; }

export type RequestedAdapter = {
  provider: ProviderKey;
  adapter: ProviderAdapter;
  accessMethod: "api" | "search_api";
  modelOrSurface: string;
  timeoutMs: number;
  tokenUsageExpected: boolean;
  costExpected: boolean;
};

function finiteEnv(value: string | undefined, fallback?: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new WorkerConfigurationError("Provider pricing configuration is invalid.");
  return number;
}

function credential(value: string | undefined, provider: string) {
  const key = value?.trim();
  if (!key) throw new WorkerConfigurationError(`${provider} credential is not configured.`);
  return key;
}

function configNumber(configuration: Json, key: string) {
  if (!configuration || Array.isArray(configuration) || typeof configuration !== "object") return undefined;
  const value = configuration[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timeout(env: NodeJS.ProcessEnv) {
  const value = finiteEnv(env.PROVIDER_TIMEOUT_MS, 60_000)!;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) throw new WorkerConfigurationError("Provider timeout configuration is invalid.");
  return value;
}

function explicitPricing(env: NodeJS.ProcessEnv, prefix: "OPENAI" | "ANTHROPIC") {
  const input = finiteEnv(env[`${prefix}_INPUT_PER_MILLION_USD`]);
  const output = finiteEnv(env[`${prefix}_OUTPUT_PER_MILLION_USD`]);
  if (input === undefined && output === undefined) return undefined;
  if (input === undefined || output === undefined) throw new WorkerConfigurationError("Both provider token prices must be configured together.");
  return { inputPerMillionUsd: input, outputPerMillionUsd: output, source: "environment", effectiveAt: new Date().toISOString().slice(0, 10) } satisfies TokenPricing;
}

function openAIPricing(model: string, env: NodeJS.ProcessEnv): TokenPricing {
  const configured = explicitPricing(env, "OPENAI");
  if (configured) return configured;
  const prices: Record<string, [number, number]> = {
    "gpt-5.6-sol": [5, 30], "openai/gpt-5.6-sol": [5, 30], "gpt-5.6": [5, 30], "gpt-5.6-terra": [2, 12], "gpt-5.6-luna": [0.2, 1.2],
  };
  const price = prices[model];
  if (!price) throw new WorkerConfigurationError("OpenAI model pricing is not configured.");
  return { inputPerMillionUsd: price[0], outputPerMillionUsd: price[1], source: "https://developers.openai.com/api/docs/pricing", effectiveAt: "2026-08-16" };
}

function anthropicPricing(model: string, env: NodeJS.ProcessEnv): TokenPricing {
  const configured = explicitPricing(env, "ANTHROPIC");
  if (configured) return configured;
  let price: [number, number] | undefined;
  if (/claude-sonnet-5/iu.test(model)) price = [2, 10];
  else if (/claude-sonnet-4-(?:5|6)/iu.test(model)) price = [3, 15];
  else if (/claude-haiku-4-5/iu.test(model)) price = [1, 5];
  else if (/claude-(?:opus-5|opus-4-(?:5|6|7|8))/iu.test(model)) price = [5, 25];
  if (!price) throw new WorkerConfigurationError("Anthropic model pricing is not configured.");
  return { inputPerMillionUsd: price[0], outputPerMillionUsd: price[1], source: "https://platform.claude.com/docs/en/about-claude/pricing", effectiveAt: "2026-08-16" };
}

export function configuredProviderKeys(env: NodeJS.ProcessEnv = process.env): ProviderKey[] {
  return [(env.AI_GATEWAY_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()) ? "openai" as const : null, env.ANTHROPIC_API_KEY?.trim() ? "claude" as const : null, env.SERPAPI_API_KEY?.trim() ? "google_ai_overview" as const : null].filter((value): value is ProviderKey => value !== null);
}

export function createRequestedAdapter(provider: ProviderKey, configuration: Json = {}, env: NodeJS.ProcessEnv = process.env): RequestedAdapter {
  const timeoutMs = timeout(env);
  if (provider === "openai") {
    const gatewayKey = env.AI_GATEWAY_API_KEY?.trim();
    const model = env.OPENAI_MODEL?.trim() || (gatewayKey ? "openai/gpt-5.6-sol" : "gpt-5.6-luna");
    return { provider, adapter: createOpenAIAdapter({ apiKey: credential(gatewayKey || env.OPENAI_API_KEY, gatewayKey ? "Vercel AI Gateway" : "OpenAI"), baseUrl: gatewayKey ? "https://ai-gateway.vercel.sh/v1" : undefined, model, pricing: openAIPricing(model, env), webSearchCostPerRequestUsd: finiteEnv(env.OPENAI_WEB_SEARCH_COST_USD, 0.01) }), accessMethod: "api", modelOrSurface: model, timeoutMs, tokenUsageExpected: true, costExpected: true };
  }
  if (provider === "claude") {
    const model = env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5";
    return { provider, adapter: createAnthropicAdapter({ apiKey: credential(env.ANTHROPIC_API_KEY, "Anthropic"), model, pricing: anthropicPricing(model, env), webSearchCostPerRequestUsd: finiteEnv(env.ANTHROPIC_WEB_SEARCH_COST_USD, 0.01) }), accessMethod: "api", modelOrSurface: model, timeoutMs, tokenUsageExpected: true, costExpected: true };
  }
  const configuredCost = finiteEnv(env.SERPAPI_COST_PER_SEARCH_USD, configNumber(configuration, "costPerSearchUsd"));
  return { provider, adapter: createGoogleAIOverviewAdapter({ apiKey: credential(env.SERPAPI_API_KEY, "SerpAPI"), costPerSearchUsd: configuredCost }), accessMethod: "search_api", modelOrSurface: "Google AI Overview via SerpAPI", timeoutMs, tokenUsageExpected: false, costExpected: configuredCost !== undefined };
}
