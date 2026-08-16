import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProviderKey, WorkspaceRole } from "@/types/contracts";
import type { Database, Json } from "@/types/database";

export type ProductDbClient = SupabaseClient<Database>;

export type WorkspaceActor = {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
};

export type DbContext = {
  client: ProductDbClient;
  actor: WorkspaceActor;
};

export type ProductSnapshot = {
  actor: WorkspaceActor;
  workspace: { id: string; name: string; slug: string };
  setup: {
    complete: boolean;
    missing: Array<"project" | "domain" | "category" | "primary_brand" | "competitor" | "question">;
  };
  counts: { projects: number; questions: number; evidence: number; runs: number; actions: number };
  providers: ProviderHealth[];
  usage: UsageSummary;
  recentRuns: RunSummary[];
  pendingReviewCount: number;
};

export type ProviderHealth = {
  provider: ProviderKey;
  configured: boolean;
  enabled: boolean;
  state: "unchecked" | "healthy" | "degraded" | "unavailable";
  remediation: string | null;
  lastCheckedAt: string | null;
};

export type UsageSummary = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  reservedCalls: number;
  reservedCostUsd: number;
  callLimit: number;
  costLimitUsd: number;
  ambiguousEventCount: number;
  incompleteEventCount: number;
  ambiguousCallCount: number;
};

export type RunSummary = {
  id: string; projectId: string; status: string; requestedCaptureCount: number;
  createdAt: string; startedAt: string | null; completedAt: string | null;
};

export type QuestionSetSummary = {
  id: string;
  name: string;
  version: number;
  cohortHash: string;
  createdAt: string;
  questionVersionIds: string[];
};

export type RunPreflightQuota = {
  configured: boolean;
  callsUsed: number;
  callLimit: number | null;
  callsRemaining: number | null;
  requiredCalls: number;
  callShortfall: number;
  costUsedUsd: number;
  costLimitUsd: number | null;
  costRemainingUsd: number | null;
  requiredCostUsd: number;
  costShortfallUsd: number;
  ready: boolean;
  reason:
    | "quota_not_configured"
    | "no_active_questions"
    | "invalid_question_quality"
    | "no_available_provider"
    | "provider_budget_unavailable"
    | "insufficient_calls"
    | "insufficient_cost"
    | "insufficient_calls_and_cost"
    | null;
};

export type ProviderBudgetAssumption = {
  provider: ProviderKey;
  maxCallsPerCapture: number;
  maxCostPerCaptureUsd: number;
  rationale: string;
  updatedAt: string;
};

export type RunPreflight = {
  projectId: string;
  activeQuestionVersionIds: string[];
  activeQuestionSetId: string | null;
  providers: ProviderHealth[];
  selectedProviderKeys: ProviderKey[];
  providerBudgetAssumptions: ProviderBudgetAssumption[];
  providersMissingBudgetCaps: ProviderKey[];
  invalidQuestionIds: string[];
  estimatedCaptureCount: number;
  quota: RunPreflightQuota;
};

export type ClassificationFacts = {
  mentioned: boolean;
  cited: boolean;
  shortlisted: boolean;
  explicitlyRecommended: boolean;
  firstChoice: boolean;
  rejected: boolean;
  rank: number | null;
} & { [key: string]: Json | undefined };

export type PendingClassificationReview = {
  classificationId: string;
  brandVersionId: string;
  facts: ClassificationFacts;
  confidence: number;
  rationale: string;
  evidenceSpans: Json[];
  observation: {
    id: string;
    answerText: string | null;
    provider: ProviderKey;
    accessMethod: string;
    modelOrSurface: string | null;
    capturedAt: string;
  };
  beforeValue: ClassificationFacts;
};

export type HydratedCaptureJob = {
  id: string;
  workspaceId: string;
  projectId: string;
  runId: string;
  questionId: string;
  questionVersionId: string;
  prompt: string;
  provider: ProviderKey;
  locale: string;
  market: string;
  attemptCount: number;
  maxAttempts: number;
  leaseExpiresAt: string;
  providerConnection: null | {
    enabled: boolean;
    healthState: string;
    configuration: Json;
  };
  brands: Array<{
    brandVersionId: string;
    brandId: string;
    name: string;
    domain: string;
    aliases: string[];
    role: "primary" | "competitor";
    position: number;
  }>;
};

export type AttemptUsageInput = {
  callCount: number;
  searchRequests?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  usageComplete: boolean;
  billingAmbiguous: boolean;
};

export type CompleteJobInput = {
  client: ProductDbClient;
  jobId: string;
  workerId: string;
  accessMethod: "api" | "search_api";
  modelOrSurface: string;
  exactPrompt: string;
  providerRequestId?: string;
  requestedAt: string;
  capturedAt: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  usage: AttemptUsageInput;
  rawResponse: Json;
  answerText: string;
  citations?: Array<{ url: string; originalUrl?: string; canonicalUrl?: string; title?: string; position?: number; evidenceExcerpt?: string }>;
  classifications?: Array<{
    brandVersionId: string; mentioned: boolean; cited: boolean; shortlisted: boolean;
    explicitlyRecommended: boolean; firstChoice: boolean; rejected: boolean;
    rank?: number; confidence: number; evidenceSpans: Json[]; rationale: string; requiresReview: boolean;
  }>;
  classifier?: { name: string; version: string; inputHash: string };
};

export type FailJobInput = {
  client: ProductDbClient;
  jobId: string;
  workerId: string;
  status: "failed" | "unavailable";
  accessMethod: "api" | "search_api";
  modelOrSurface: string;
  exactPrompt: string;
  providerRequestId?: string;
  requestedAt: string;
  capturedAt: string;
  latencyMs: number;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  retryAt?: string;
  usage: AttemptUsageInput;
  rawResponse?: Json;
};
