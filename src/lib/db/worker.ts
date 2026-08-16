import { databaseFailure } from "./errors";
import type { CompleteJobInput, FailJobInput, HydratedCaptureJob, ProductDbClient } from "./types";

export async function leaseNextJobs(input: { client: ProductDbClient; workerId: string; limit?: number; leaseSeconds?: number }) {
  const { data, error } = await input.client.rpc("lease_capture_jobs", { p_worker_id: input.workerId, p_limit: input.limit ?? 10, p_lease_seconds: input.leaseSeconds ?? 120 });
  if (error) databaseFailure("Unable to lease capture jobs.", error); return data ?? [];
}

export async function completeJob(input: CompleteJobInput) {
  const { data, error } = await input.client.rpc("complete_capture_job_v2", {
    p_job_id: input.jobId, p_worker_id: input.workerId, p_access_method: input.accessMethod,
    p_model_or_surface: input.modelOrSurface, p_exact_prompt: input.exactPrompt,
    p_provider_request_id: input.providerRequestId ?? null, p_requested_at: input.requestedAt,
    p_captured_at: input.capturedAt, p_latency_ms: input.latencyMs,
    p_call_count: input.usage.callCount, p_search_requests: input.usage.searchRequests ?? null,
    p_input_tokens: input.usage.inputTokens ?? input.inputTokens ?? null,
    p_output_tokens: input.usage.outputTokens ?? input.outputTokens ?? null,
    p_estimated_cost_usd: input.usage.estimatedCostUsd ?? input.estimatedCostUsd ?? null,
    p_usage_complete: input.usage.usageComplete, p_billing_ambiguous: input.usage.billingAmbiguous,
    p_raw_response: input.rawResponse, p_answer_text: input.answerText,
    p_citations: input.citations ?? [], p_classifications: input.classifications ?? [],
    p_classifier_name: input.classifier?.name ?? null,
    p_classifier_version: input.classifier?.version ?? null,
    p_classifier_input_hash: input.classifier?.inputHash ?? null,
  });
  if (error) databaseFailure("Unable to complete the capture job.", error); return data;
}

export async function failJob(input: FailJobInput) {
  const { data, error } = await input.client.rpc("fail_capture_job_v2", {
    p_job_id: input.jobId, p_worker_id: input.workerId, p_status: input.status,
    p_access_method: input.accessMethod, p_model_or_surface: input.modelOrSurface,
    p_exact_prompt: input.exactPrompt, p_provider_request_id: input.providerRequestId ?? null,
    p_requested_at: input.requestedAt, p_captured_at: input.capturedAt,
    p_latency_ms: input.latencyMs, p_error_code: input.errorCode,
    p_error_message: input.errorMessage, p_retryable: input.retryable,
    p_retry_at: input.retryAt ?? null, p_call_count: input.usage.callCount,
    p_search_requests: input.usage.searchRequests ?? null,
    p_input_tokens: input.usage.inputTokens ?? null, p_output_tokens: input.usage.outputTokens ?? null,
    p_estimated_cost_usd: input.usage.estimatedCostUsd ?? null,
    p_usage_complete: input.usage.usageComplete, p_billing_ambiguous: input.usage.billingAmbiguous,
    p_raw_response: input.rawResponse ?? null,
  });
  if (error) databaseFailure("Unable to fail the capture job.", error); return data;
}

export async function hydrateCaptureJob(input: { client: ProductDbClient; jobId: string; workerId: string }) {
  const { data, error } = await input.client.rpc("hydrate_capture_job_v2", { p_job_id: input.jobId, p_worker_id: input.workerId });
  if (error) databaseFailure("Unable to hydrate the capture job.", error);
  return data as unknown as HydratedCaptureJob;
}

export async function recoverExpiredLeases(input: { client: ProductDbClient; now?: string }) {
  const { data, error } = await input.client.rpc("recover_expired_capture_leases", { p_now: input.now });
  if (error) databaseFailure("Unable to recover expired capture leases.", error); return data ?? 0;
}

export async function enqueueScheduledRuns(input: { client: ProductDbClient; now?: string }) {
  const { data, error } = await input.client.rpc("enqueue_due_schedules", { p_now: input.now });
  if (error) databaseFailure("Unable to enqueue scheduled runs.", error); return data ?? 0;
}
