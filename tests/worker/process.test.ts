import { describe, expect, it, vi } from "vitest";
import type { ProviderAdapter } from "@/lib/ai";
import type { ProductDbClient } from "@/lib/db";
import type { RunItemRow } from "@/types/database";
import { processCaptureJob, retryAt, runWorkerCycle, type WorkerDependencies } from "@/lib/worker/process";

const ids = {
  job: "00000000-0000-4000-8000-000000000001",
  workspace: "00000000-0000-4000-8000-000000000002",
  project: "00000000-0000-4000-8000-000000000003",
  run: "00000000-0000-4000-8000-000000000004",
  question: "00000000-0000-4000-8000-000000000005",
  questionVersion: "00000000-0000-4000-8000-000000000006",
  acmeVersion: "00000000-0000-4000-8000-000000000007",
  acme: "00000000-0000-4000-8000-000000000008",
  betaVersion: "00000000-0000-4000-8000-000000000009",
  beta: "00000000-0000-4000-8000-000000000010",
};

const now = new Date("2026-08-16T12:00:00.000Z");
const client = {} as ProductDbClient;
const adapter: ProviderAdapter = { key: "openai", capture: vi.fn() };

function hydrated(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.job,
    workspaceId: ids.workspace,
    projectId: ids.project,
    runId: ids.run,
    questionId: ids.question,
    questionVersionId: ids.questionVersion,
    prompt: "Which vendor is best?",
    provider: "openai" as const,
    locale: "en-US",
    market: "us",
    attemptCount: 2,
    maxAttempts: 3,
    leaseExpiresAt: "2026-08-16T12:05:00.000Z",
    providerConnection: { enabled: true, healthState: "unchecked", configuration: {} },
    brands: [
      { brandVersionId: ids.acmeVersion, brandId: ids.acme, name: "Acme", domain: "acme.test", aliases: [], role: "primary" as const, position: 1 },
      { brandVersionId: ids.betaVersion, brandId: ids.beta, name: "Beta", domain: "beta.test", aliases: [], role: "competitor" as const, position: 2 },
    ],
    ...overrides,
  };
}

function dependencies(overrides: Partial<WorkerDependencies> = {}): Partial<WorkerDependencies> {
  return {
    clock: { now: () => new Date(now) },
    hydrate: vi.fn().mockResolvedValue(hydrated()),
    createAdapter: vi.fn().mockReturnValue({ provider: "openai", adapter, accessMethod: "api", modelOrSurface: "gpt-5.6-luna", timeoutMs: 60_000, tokenUsageExpected: true, costExpected: true }),
    complete: vi.fn().mockResolvedValue(ids.job),
    fail: vi.fn().mockResolvedValue("failed"),
    markHealthy: vi.fn().mockResolvedValue(undefined),
    markFailure: vi.fn().mockResolvedValue(undefined),
    dispatchWebhooks: vi.fn().mockResolvedValue([]),
    cleanupStorage: vi.fn().mockResolvedValue({ claimed: 1, succeeded: 1, deferred: 0, abandoned: 0 }),
    ...overrides,
  };
}

describe("durable capture processing", () => {
  it("captures the exact provider and persists every frozen brand with exact usage", async () => {
    const complete = vi.fn().mockResolvedValue(ids.job);
    const capture = vi.fn().mockResolvedValue({
      ok: true,
      result: { provider: "openai", accessMethod: "api", modelOrSurface: "gpt-5.6-luna", providerRequestId: "req_1", answerText: "1. Acme is the first choice. Beta is shortlisted.", citations: [{ url: "https://acme.test/proof" }], inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.001, latencyMs: 20, capturedAt: now.toISOString(), rawResponse: { id: "req_1", output: [] } },
      usage: { inputTokens: 100, outputTokens: 20, searchRequests: 0, estimatedCostUsd: 0.001, costMethod: "configured_estimate" },
      provenance: { accessMethod: "api", modelOrSurface: "gpt-5.6-luna", providerRequestId: "req_1", capturedAt: now.toISOString(), latencyMs: 20 },
    });
    const deps = dependencies({ capture, complete });
    const result = await processCaptureJob({ client, workerId: "worker:test", jobId: ids.job, env: { NODE_ENV: "test", OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv, dependencies: deps });

    expect(result.status).toBe("succeeded");
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", request: expect.objectContaining({ jobId: ids.job, prompt: "Which vendor is best?", locale: "en-US", market: "us" }) }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      jobId: ids.job,
      exactPrompt: "Which vendor is best?",
      usage: { callCount: 1, searchRequests: 0, inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.001, usageComplete: true, billingAmbiguous: false },
      classifications: expect.arrayContaining([
        expect.objectContaining({ brandVersionId: ids.acmeVersion, mentioned: true, firstChoice: true }),
        expect.objectContaining({ brandVersionId: ids.betaVersion, mentioned: true, shortlisted: true }),
      ]),
      classifier: expect.objectContaining({ name: "refinestack-deterministic", version: "2.1.0", inputHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    }));
    expect(deps.markHealthy).toHaveBeenCalledWith(client, ids.workspace, "openai", now.toISOString());
  });

  it("does not contact a disabled workspace provider", async () => {
    const capture = vi.fn();
    const fail = vi.fn().mockResolvedValue("unavailable");
    const result = await processCaptureJob({ client, workerId: "worker:test", jobId: ids.job, dependencies: dependencies({ hydrate: vi.fn().mockResolvedValue(hydrated({ providerConnection: { enabled: false, healthState: "unchecked", configuration: {} } })), capture, fail }) });
    expect(result).toMatchObject({ status: "unavailable", code: "provider_disabled" });
    expect(capture).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "provider_disabled", usage: { callCount: 0, searchRequests: 0, usageComplete: true, billingAmbiguous: false } }));
  });

  it("honors Retry-After and persists ambiguous failure usage", async () => {
    const fail = vi.fn().mockResolvedValue("queued");
    const capture = vi.fn().mockResolvedValue({ ok: false, failure: { provider: "openai", code: "rate_limited", message: "slow down api_key=secret", retryable: true, retryAfterMs: 30_000, usage: { requestCount: 1, inputTokens: undefined, outputTokens: undefined, searchRequests: undefined, estimatedCostUsd: undefined, costMethod: "unavailable", ambiguousBilling: true } } });
    const result = await processCaptureJob({ client, workerId: "worker:test", jobId: ids.job, dependencies: dependencies({ capture, fail }) });
    expect(result.status).toBe("queued");
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      retryable: true,
      retryAt: "2026-08-16T12:00:30.000Z",
      errorMessage: "slow down api_key=[redacted]",
      usage: expect.objectContaining({ callCount: 1, usageComplete: false, billingAmbiguous: true }),
    }));
  });

  it("records a provider call even when an unavailable response omitted its count", async () => {
    const fail = vi.fn().mockResolvedValue("unavailable");
    const capture = vi.fn().mockResolvedValue({ ok: false, failure: { provider: "openai", code: "unavailable", message: "No result", retryable: false, usage: { requestCount: 0, costMethod: "unavailable", ambiguousBilling: false } } });
    await processCaptureJob({ client, workerId: "worker:test", jobId: ids.job, dependencies: dependencies({ capture, fail }) });
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ usage: expect.objectContaining({ callCount: 1, usageComplete: false, billingAmbiguous: true }) }));
  });

  it("marks the worker deadline as a retryable timeout instead of unavailable", async () => {
    const fail = vi.fn().mockResolvedValue("queued");
    const capture = vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve({
        ok: false,
        failure: {
          provider: "openai",
          code: signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "timeout" : "unavailable",
          message: "deadline",
          retryable: signal.reason instanceof Error && signal.reason.name === "TimeoutError",
          usage: { requestCount: 1, costMethod: "unavailable", ambiguousBilling: true },
        },
      }), { once: true });
    }));
    const result = await processCaptureJob({
      client,
      workerId: "worker:test",
      jobId: ids.job,
      dependencies: dependencies({
        capture: capture as WorkerDependencies["capture"],
        fail,
        createAdapter: vi.fn().mockReturnValue({ provider: "openai", adapter, accessMethod: "api", modelOrSurface: "m", timeoutMs: 5, tokenUsageExpected: true, costExpected: true }),
      }),
    });
    expect(result).toMatchObject({ status: "queued", code: "timeout" });
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ retryable: true, errorCode: "timeout" }));
  });

  it("bounds exponential retry delays to one day", () => {
    expect(retryAt({ now, attemptCount: 1 })).toBe("2026-08-16T12:00:05.000Z");
    expect(retryAt({ now, attemptCount: 99, retryAfterMs: 10 * 24 * 60 * 60 * 1_000 })).toBe("2026-08-17T12:00:00.000Z");
  });

  it("runs maintenance, leases a bounded batch, and contains individual faults", async () => {
    const leased = [{ id: ids.job }, { id: ids.acme }] as RunItemRow[];
    const deps = dependencies({
      syncHealth: vi.fn().mockResolvedValue({ workspaces: 1, providers: 1, inserted: 1 }),
      recover: vi.fn().mockResolvedValue(2),
      enqueue: vi.fn().mockResolvedValue(3),
      lease: vi.fn().mockResolvedValue(leased),
      hydrate: vi.fn().mockRejectedValue(new Error("bad hydration")),
    });
    const result = await runWorkerCycle({ client, workerId: "worker:test", limit: 99, leaseSeconds: 10, dependencies: deps });
    expect(deps.lease).toHaveBeenCalledWith({ client, workerId: "worker:test", limit: 10, leaseSeconds: 180 });
    expect(deps.dispatchWebhooks).toHaveBeenCalledWith({ limit: 10, now });
    expect(deps.cleanupStorage).toHaveBeenCalledWith(client, "worker:test", 10);
    expect(result).toMatchObject({ maintenance: { providersInserted: 1, leasesRecovered: 2, runsEnqueued: 3, storageCleanup: { claimed: 1, succeeded: 1, deferred: 0, abandoned: 0, unavailable: false } }, leased: 2, deferred: 2, webhooks: { processed: 0, dispatchFailed: false } });
  });

  it("contains storage cleanup infrastructure faults without blocking capture work", async () => {
    const deps = dependencies({
      syncHealth: vi.fn().mockResolvedValue({ workspaces: 0, providers: 0, inserted: 0 }),
      recover: vi.fn().mockResolvedValue(0),
      enqueue: vi.fn().mockResolvedValue(0),
      cleanupStorage: vi.fn().mockRejectedValue(new Error("cleanup unavailable")),
      lease: vi.fn().mockResolvedValue([]),
    });
    const result = await runWorkerCycle({ client, workerId: "worker:test", dependencies: deps });
    expect(result.maintenance.storageCleanup).toEqual({ claimed: 0, succeeded: 0, deferred: 0, abandoned: 0, unavailable: true });
    expect(deps.lease).toHaveBeenCalled();
  });
});
