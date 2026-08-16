import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  captureProvider,
  brandNeedsContext,
  classifyBrand,
  type CaptureProviderOutcome,
} from "@/lib/ai";
import {
  completeJob,
  enqueueScheduledRuns,
  failJob,
  hydrateCaptureJob,
  leaseNextJobs,
  recoverExpiredLeases,
  type AttemptUsageInput,
  type CompleteJobInput,
  type FailJobInput,
  type HydratedCaptureJob,
  type ProductDbClient,
} from "@/lib/db";
import { dispatchPendingWebhooks } from "@/lib/platform/webhooks";
import { redactSecrets } from "@/lib/security/secrets";
import type { ProviderKey } from "@/types/contracts";
import type { Json } from "@/types/database";
import {
  createRequestedAdapter,
  type RequestedAdapter,
  WorkerConfigurationError,
} from "./adapters";
import { drainWorkspaceStorageCleanupQueue, markProviderFailure, markProviderHealthy, syncProviderHealth } from "./maintenance";

const hydratedJobSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  questionId: z.string().uuid(),
  questionVersionId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(100_000),
  provider: z.enum(["openai", "claude", "google_ai_overview"]),
  locale: z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/u),
  market: z.string().trim().min(2).max(64),
  attemptCount: z.number().int().min(1).max(1_000),
  maxAttempts: z.number().int().min(1).max(1_000),
  leaseExpiresAt: z.string().datetime({ offset: true }),
  providerConnection: z.object({
    enabled: z.boolean(),
    healthState: z.string().max(64),
    configuration: z.unknown(),
  }).nullable(),
  brands: z.array(z.object({
    brandVersionId: z.string().uuid(),
    brandId: z.string().uuid(),
    name: z.string().trim().min(1).max(240),
    domain: z.string().trim().min(1).max(2_048),
    aliases: z.array(z.string().trim().min(1).max(240)).max(100),
    role: z.enum(["primary", "competitor"]),
    position: z.number().int().min(1).max(10_000),
  })).max(1_000),
}).strict();

const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

type WorkerClock = { now: () => Date };

export type WorkerDependencies = {
  clock: WorkerClock;
  createAdapter: typeof createRequestedAdapter;
  capture: typeof captureProvider;
  hydrate: typeof hydrateCaptureJob;
  complete: typeof completeJob;
  fail: typeof failJob;
  lease: typeof leaseNextJobs;
  recover: typeof recoverExpiredLeases;
  enqueue: typeof enqueueScheduledRuns;
  syncHealth: typeof syncProviderHealth;
  markHealthy: typeof markProviderHealthy;
  markFailure: typeof markProviderFailure;
  dispatchWebhooks: typeof dispatchPendingWebhooks;
  cleanupStorage: typeof drainWorkspaceStorageCleanupQueue;
};

const defaultDependencies: WorkerDependencies = {
  clock: { now: () => new Date() },
  createAdapter: createRequestedAdapter,
  capture: captureProvider,
  hydrate: hydrateCaptureJob,
  complete: completeJob,
  fail: failJob,
  lease: leaseNextJobs,
  recover: recoverExpiredLeases,
  enqueue: enqueueScheduledRuns,
  syncHealth: syncProviderHealth,
  markHealthy: markProviderHealthy,
  markFailure: markProviderFailure,
  dispatchWebhooks: dispatchPendingWebhooks,
  cleanupStorage: drainWorkspaceStorageCleanupQueue,
};

function jsonValue(value: unknown, redact = false): Json {
  const serializable = redact ? redactSecrets(value) : value;
  return JSON.parse(JSON.stringify(serializable ?? null)) as Json;
}

function safeErrorMessage(value: unknown) {
  const message = typeof value === "string" ? value : value instanceof Error ? value.message : "Unexpected worker failure.";
  const redacted = redactSecrets(message);
  return (typeof redacted === "string" ? redacted : "Unexpected worker failure.")
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 1_000);
}

function targetDescriptor(provider: ProviderKey, env: NodeJS.ProcessEnv) {
  if (provider === "openai") return { accessMethod: "api" as const, modelOrSurface: env.OPENAI_MODEL?.trim() || "gpt-5.6-luna" };
  if (provider === "claude") return { accessMethod: "api" as const, modelOrSurface: env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5" };
  return { accessMethod: "search_api" as const, modelOrSurface: "Google AI Overview via SerpAPI" };
}

function successfulCallCount(provider: ProviderKey, rawResponse: unknown) {
  if (provider === "openai") return 1;
  if (!rawResponse || typeof rawResponse !== "object") return 1;
  const record = rawResponse as Record<string, unknown>;
  if (Number.isSafeInteger(record.requestCount) && Number(record.requestCount) >= 1) return Number(record.requestCount);
  if (provider === "claude" && Array.isArray(record.turns) && record.turns.length > 0) return record.turns.length;
  return 1;
}

function usageForSuccess(adapter: RequestedAdapter, outcome: Extract<CaptureProviderOutcome, { ok: true }>): AttemptUsageInput {
  const callCount = successfulCallCount(adapter.provider, outcome.result.rawResponse);
  const tokensComplete = !adapter.tokenUsageExpected
    || (outcome.usage.inputTokens !== undefined && outcome.usage.outputTokens !== undefined);
  const costComplete = adapter.costExpected && outcome.usage.estimatedCostUsd !== undefined;
  const searchComplete = outcome.usage.searchRequests !== undefined;
  return {
    callCount,
    searchRequests: outcome.usage.searchRequests,
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
    estimatedCostUsd: outcome.usage.estimatedCostUsd,
    usageComplete: tokensComplete && costComplete && searchComplete,
    billingAmbiguous: !costComplete,
  };
}

function usageForFailure(adapter: RequestedAdapter, outcome: Extract<CaptureProviderOutcome, { ok: false }>): AttemptUsageInput {
  const usage = outcome.failure.usage;
  // Adapter construction and request validation happen before this boundary, so
  // reaching a capture failure means one outbound provider request was attempted.
  const callCount = Math.max(1, usage.requestCount);
  const tokensComplete = !adapter.tokenUsageExpected
    || (usage.inputTokens !== undefined && usage.outputTokens !== undefined);
  const costComplete = adapter.costExpected && usage.estimatedCostUsd !== undefined;
  return {
    callCount,
    searchRequests: usage.searchRequests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
    usageComplete: tokensComplete && costComplete && usage.searchRequests !== undefined,
    billingAmbiguous: usage.ambiguousBilling || usage.requestCount === 0 || !costComplete,
  };
}

function zeroUsage(): AttemptUsageInput {
  return { callCount: 0, searchRequests: 0, usageComplete: true, billingAmbiguous: false };
}

export function retryAt(input: { now: Date; attemptCount: number; retryAfterMs?: number }) {
  const exponent = Math.max(0, Math.min(12, input.attemptCount - 1));
  const exponential = Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * (2 ** exponent));
  const providerDelay = Number.isFinite(input.retryAfterMs) && (input.retryAfterMs ?? 0) >= 0
    ? Math.min(MAX_RETRY_DELAY_MS, Math.ceil(input.retryAfterMs!))
    : 0;
  return new Date(input.now.getTime() + Math.max(exponential, providerDelay)).toISOString();
}

function classifierHash(job: HydratedCaptureJob, answerText: string, citations: unknown) {
  return createHash("sha256").update(JSON.stringify({
    answerText,
    citations,
    runId: job.runId,
    questionVersionId: job.questionVersionId,
    brandVersionIds: job.brands.map((brand) => brand.brandVersionId),
    classifierName: "refinestack-deterministic",
    classifierVersion: "2.1.0",
  }), "utf8").digest("hex");
}

async function updateHealthSafely(action: () => Promise<void>) {
  try { await action(); } catch { /* The durable job result must not be retried for health telemetry failure. */ }
}

async function persistPreflightFailure(input: {
  client: ProductDbClient;
  workerId: string;
  job: HydratedCaptureJob;
  code: string;
  message: string;
  now: Date;
  env: NodeJS.ProcessEnv;
  dependencies: WorkerDependencies;
}) {
  const target = targetDescriptor(input.job.provider, input.env);
  await input.dependencies.fail({
    client: input.client,
    jobId: input.job.id,
    workerId: input.workerId,
    status: "unavailable",
    ...target,
    exactPrompt: input.job.prompt,
    requestedAt: input.now.toISOString(),
    capturedAt: input.now.toISOString(),
    latencyMs: 0,
    errorCode: input.code,
    errorMessage: input.message,
    retryable: false,
    usage: zeroUsage(),
    rawResponse: null,
  });
}

export async function processCaptureJob(input: {
  client: ProductDbClient;
  workerId: string;
  jobId: string;
  env?: NodeJS.ProcessEnv;
  dependencies?: Partial<WorkerDependencies>;
}) {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const env = input.env ?? process.env;
  const hydrated = await dependencies.hydrate({ client: input.client, jobId: input.jobId, workerId: input.workerId });
  const parsed = hydratedJobSchema.safeParse(hydrated);
  if (!parsed.success) throw new Error("Leased capture job failed hydration validation.");
  const job = parsed.data as HydratedCaptureJob;
  const preflightTime = dependencies.clock.now();

  if (!job.providerConnection?.enabled) {
    await persistPreflightFailure({ client: input.client, workerId: input.workerId, job, code: "provider_disabled", message: "The requested provider connection is not enabled for this workspace.", now: preflightTime, env, dependencies });
    return { jobId: job.id, status: "unavailable" as const, code: "provider_disabled" };
  }
  if (job.brands.length === 0) {
    await persistPreflightFailure({ client: input.client, workerId: input.workerId, job, code: "frozen_brand_cohort_missing", message: "The run has no frozen brand cohort to classify.", now: preflightTime, env, dependencies });
    return { jobId: job.id, status: "unavailable" as const, code: "frozen_brand_cohort_missing" };
  }

  let requested: RequestedAdapter;
  try {
    requested = dependencies.createAdapter(job.provider, job.providerConnection.configuration, env);
  } catch (error) {
    const message = error instanceof WorkerConfigurationError ? safeErrorMessage(error) : "The requested provider could not be configured.";
    await persistPreflightFailure({ client: input.client, workerId: input.workerId, job, code: "provider_configuration", message, now: preflightTime, env, dependencies });
    await updateHealthSafely(() => dependencies.markFailure(input.client, job.workspaceId, job.provider, "unavailable", preflightTime.toISOString()));
    return { jobId: job.id, status: "unavailable" as const, code: "provider_configuration" };
  }

  const requestedAt = dependencies.clock.now();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(
    new DOMException("Provider capture exceeded the worker deadline", "TimeoutError"),
  ), requested.timeoutMs);
  let outcome: CaptureProviderOutcome;
  try {
    outcome = await dependencies.capture({
      provider: job.provider,
      adapter: requested.adapter,
      signal: controller.signal,
      request: {
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        runId: job.runId,
        jobId: job.id,
        questionId: job.questionId,
        prompt: job.prompt,
        locale: job.locale,
        market: job.market,
        timeoutMs: requested.timeoutMs,
      },
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!outcome.ok) {
    const capturedAt = dependencies.clock.now();
    const terminalUnavailable = outcome.failure.code === "authentication" || outcome.failure.code === "unavailable";
    const failureInput: FailJobInput = {
      client: input.client,
      jobId: job.id,
      workerId: input.workerId,
      status: terminalUnavailable ? "unavailable" : "failed",
      accessMethod: requested.accessMethod,
      modelOrSurface: requested.modelOrSurface,
      exactPrompt: job.prompt,
      providerRequestId: outcome.failure.providerRequestId,
      requestedAt: requestedAt.toISOString(),
      capturedAt: capturedAt.toISOString(),
      latencyMs: Math.max(0, capturedAt.getTime() - requestedAt.getTime()),
      errorCode: outcome.failure.code,
      errorMessage: safeErrorMessage(outcome.failure.message),
      retryable: outcome.failure.retryable,
      retryAt: outcome.failure.retryable ? retryAt({ now: capturedAt, attemptCount: job.attemptCount, retryAfterMs: outcome.failure.retryAfterMs }) : undefined,
      usage: usageForFailure(requested, outcome),
      rawResponse: outcome.failure.rawResponse === undefined ? null : jsonValue(outcome.failure.rawResponse, true),
    };
    const status = await dependencies.fail(failureInput);
    await updateHealthSafely(() => dependencies.markFailure(input.client, job.workspaceId, job.provider, outcome.failure.code, capturedAt.toISOString()));
    return { jobId: job.id, status, code: outcome.failure.code };
  }

  const usage = usageForSuccess(requested, outcome);
  const capturedAtMs = Date.parse(outcome.provenance.capturedAt);
  if (!Number.isFinite(capturedAtMs)
    || capturedAtMs < requestedAt.getTime()
    || !Number.isSafeInteger(outcome.provenance.latencyMs)
    || outcome.provenance.latencyMs < 0
    || !outcome.provenance.modelOrSurface.trim()) {
    const capturedAt = dependencies.clock.now();
    await dependencies.fail({
      client: input.client,
      jobId: job.id,
      workerId: input.workerId,
      status: "failed",
      accessMethod: requested.accessMethod,
      modelOrSurface: requested.modelOrSurface,
      exactPrompt: job.prompt,
      providerRequestId: outcome.provenance.providerRequestId,
      requestedAt: requestedAt.toISOString(),
      capturedAt: capturedAt.toISOString(),
      latencyMs: Math.max(0, capturedAt.getTime() - requestedAt.getTime()),
      errorCode: "malformed_response",
      errorMessage: "Provider capture provenance was invalid.",
      retryable: false,
      usage,
      rawResponse: jsonValue(outcome.result.rawResponse, true),
    });
    await updateHealthSafely(() => dependencies.markFailure(input.client, job.workspaceId, job.provider, "malformed_response", capturedAt.toISOString()));
    return { jobId: job.id, status: "failed" as const, code: "malformed_response" };
  }

  let classifications: CompleteJobInput["classifications"];
  let rawResponse: Json;
  try {
    classifications = job.brands.map((brand) => {
      const result = classifyBrand({
        answerText: outcome.result.answerText,
        citations: outcome.result.citations,
        brand: {
          brandId: brand.brandVersionId,
          name: brand.name,
          aliases: brand.aliases,
          ownedDomains: [brand.domain],
          requireContext: brandNeedsContext(brand.name, brand.aliases),
        },
      });
      return {
        brandVersionId: brand.brandVersionId,
        mentioned: result.mentioned,
        cited: result.cited,
        shortlisted: result.rationale.includes("shortlist evidence found") || (result.rank !== null && result.rank > 1),
        explicitlyRecommended: result.explicitlyRecommended,
        firstChoice: result.firstChoice,
        rejected: result.rejected,
        rank: result.rank ?? undefined,
        confidence: result.confidence,
        evidenceSpans: result.evidenceSpans,
        rationale: result.rationale,
        requiresReview: result.requiresReview,
      };
    });
    rawResponse = jsonValue(outcome.result.rawResponse);
  } catch (error) {
    const capturedAt = dependencies.clock.now();
    await dependencies.fail({
      client: input.client,
      jobId: job.id,
      workerId: input.workerId,
      status: "failed",
      accessMethod: requested.accessMethod,
      modelOrSurface: requested.modelOrSurface,
      exactPrompt: job.prompt,
      providerRequestId: outcome.provenance.providerRequestId,
      requestedAt: requestedAt.toISOString(),
      capturedAt: capturedAt.toISOString(),
      latencyMs: Math.max(outcome.provenance.latencyMs, capturedAt.getTime() - requestedAt.getTime()),
      errorCode: "classification_error",
      errorMessage: safeErrorMessage(error),
      retryable: false,
      usage,
      rawResponse: jsonValue(outcome.result.rawResponse),
    });
    return { jobId: job.id, status: "failed" as const, code: "classification_error" };
  }
  await dependencies.complete({
    client: input.client,
    jobId: job.id,
    workerId: input.workerId,
    accessMethod: outcome.provenance.accessMethod,
    modelOrSurface: outcome.provenance.modelOrSurface,
    exactPrompt: job.prompt,
    providerRequestId: outcome.provenance.providerRequestId,
    requestedAt: requestedAt.toISOString(),
    capturedAt: outcome.provenance.capturedAt,
    latencyMs: outcome.provenance.latencyMs,
    usage,
    rawResponse,
    answerText: outcome.result.answerText,
    citations: outcome.result.citations,
    classifications,
    classifier: {
      name: "refinestack-deterministic",
      version: "2.1.0",
      inputHash: classifierHash(job, outcome.result.answerText, outcome.result.citations),
    },
  });
  await updateHealthSafely(() => dependencies.markHealthy(input.client, job.workspaceId, job.provider, outcome.provenance.capturedAt));
  return { jobId: job.id, status: "succeeded" as const };
}

export type WorkerCycleResult = {
  workerId: string;
  maintenance: {
    providersInserted: number;
    leasesRecovered: number;
    runsEnqueued: number;
    storageCleanup: { claimed: number; succeeded: number; deferred: number; abandoned: number; unavailable: boolean };
  };
  leased: number;
  succeeded: number;
  failed: number;
  unavailable: number;
  deferred: number;
  webhooks: { processed: number; dispatchFailed: boolean };
};

export async function runWorkerCycle(input: {
  client: ProductDbClient;
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  env?: NodeJS.ProcessEnv;
  dependencies?: Partial<WorkerDependencies>;
}): Promise<WorkerCycleResult> {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const now = dependencies.clock.now().toISOString();
  const limit = Math.max(1, Math.min(10, Math.trunc(input.limit ?? 2)));
  const leaseSeconds = Math.max(180, Math.min(3_600, Math.trunc(input.leaseSeconds ?? 300)));
  if (!input.workerId.trim() || input.workerId.length > 200) throw new Error("Worker identity is invalid.");

  const health = await dependencies.syncHealth(input.client, input.env ?? process.env);
  const leasesRecovered = await dependencies.recover({ client: input.client, now });
  const runsEnqueued = await dependencies.enqueue({ client: input.client, now });
  let storageCleanup = { claimed: 0, succeeded: 0, deferred: 0, abandoned: 0, unavailable: false };
  try {
    storageCleanup = {
      ...await dependencies.cleanupStorage(input.client, input.workerId, limit),
      unavailable: false,
    };
  } catch {
    storageCleanup.unavailable = true;
  }
  const leased = await dependencies.lease({ client: input.client, workerId: input.workerId, limit, leaseSeconds });
  const result: WorkerCycleResult = {
    workerId: input.workerId,
    maintenance: { providersInserted: health.inserted, leasesRecovered, runsEnqueued, storageCleanup },
    leased: leased.length,
    succeeded: 0,
    failed: 0,
    unavailable: 0,
    deferred: 0,
    webhooks: { processed: 0, dispatchFailed: false },
  };
  const processedItems = await Promise.allSettled(leased.map((item) => processCaptureJob({
    client: input.client,
    workerId: input.workerId,
    jobId: item.id,
    env: input.env,
    dependencies,
  })));
  for (const processedItem of processedItems) {
    try {
      if (processedItem.status === "rejected") throw processedItem.reason;
      const processed = processedItem.value;
      if (processed.status === "succeeded") result.succeeded += 1;
      else if (processed.status === "unavailable") result.unavailable += 1;
      else if (processed.status === "queued") result.deferred += 1;
      else result.failed += 1;
    } catch {
      // A persistence/hydration fault leaves the lease intact for bounded recovery.
      result.deferred += 1;
    }
  }
  try {
    const deliveries = await dependencies.dispatchWebhooks({ limit: 10, now: dependencies.clock.now() });
    result.webhooks.processed = deliveries.length;
  } catch {
    result.webhooks.dispatchFailed = true;
  }
  return result;
}
