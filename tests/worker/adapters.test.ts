import { describe, expect, it } from "vitest";
import { configuredProviderKeys, createRequestedAdapter, WorkerConfigurationError } from "@/lib/worker/adapters";

describe("worker adapter selection", () => {
  it("instantiates only the exact requested adapter", () => {
    const env = {
      NODE_ENV: "test",
      OPENAI_API_KEY: "openai-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      SERPAPI_API_KEY: "serp-key",
    } as NodeJS.ProcessEnv;
    expect(createRequestedAdapter("openai", {}, env)).toMatchObject({ provider: "openai", accessMethod: "api", modelOrSurface: "gpt-5.6-luna" });
    expect(createRequestedAdapter("claude", {}, env)).toMatchObject({ provider: "claude", accessMethod: "api", modelOrSurface: "claude-sonnet-5" });
    expect(createRequestedAdapter("google_ai_overview", { costPerSearchUsd: 0.02 }, env)).toMatchObject({ provider: "google_ai_overview", accessMethod: "search_api", costExpected: true });
  });

  it("treats whitespace and missing credentials as unavailable configuration", () => {
    expect(configuredProviderKeys({ NODE_ENV: "test", OPENAI_API_KEY: "  ", ANTHROPIC_API_KEY: "x" } as NodeJS.ProcessEnv)).toEqual(["claude"]);
    expect(configuredProviderKeys({ NODE_ENV: "test", AI_GATEWAY_API_KEY: "gateway-key" } as NodeJS.ProcessEnv)).toEqual(["openai"]);
    expect(() => createRequestedAdapter("openai", {}, { NODE_ENV: "test" } as NodeJS.ProcessEnv)).toThrow(WorkerConfigurationError);
    expect(() => createRequestedAdapter("google_ai_overview", {}, { NODE_ENV: "test" } as NodeJS.ProcessEnv)).toThrow(WorkerConfigurationError);
  });

  it("uses the Vercel AI Gateway when its project key is configured", () => {
    const adapter = createRequestedAdapter("openai", {}, {
      NODE_ENV: "test",
      AI_GATEWAY_API_KEY: "gateway-key",
    } as NodeJS.ProcessEnv);

    expect(adapter).toMatchObject({
      provider: "openai",
      accessMethod: "api",
      modelOrSurface: "openai/gpt-5.6-sol",
    });
  });

  it("rejects unknown pricing and timeouts outside the provider contract", () => {
    expect(() => createRequestedAdapter("openai", {}, { NODE_ENV: "test", OPENAI_API_KEY: "x", OPENAI_MODEL: "unpriced-model" } as NodeJS.ProcessEnv)).toThrow(WorkerConfigurationError);
    expect(() => createRequestedAdapter("openai", {}, { NODE_ENV: "test", OPENAI_API_KEY: "x", PROVIDER_TIMEOUT_MS: "120001" } as NodeJS.ProcessEnv)).toThrow(WorkerConfigurationError);
  });
});
