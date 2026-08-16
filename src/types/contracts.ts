export const providerKeys = ["openai", "claude", "google_ai_overview"] as const;
export type ProviderKey = (typeof providerKeys)[number];

export const workspaceRoles = ["owner", "admin", "analyst", "viewer"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

export const questionTypes = [
  "category_discovery",
  "recommended_vendors",
  "vendor_shortlist",
  "brand_comparison",
  "alternatives",
  "problem_solution",
  "capability_fit",
  "industry_fit",
  "persona_fit",
  "pricing_value",
  "trust_risk_compliance",
  "implementation_integration",
  "regional_market",
  "decision_criteria",
] as const;
export type QuestionType = (typeof questionTypes)[number];

export const runStates = ["queued", "running", "succeeded", "partial", "failed", "cancelled"] as const;
export type RunState = (typeof runStates)[number];

export const jobStates = ["queued", "leased", "succeeded", "failed", "unavailable", "cancelled"] as const;
export type JobState = (typeof jobStates)[number];

export const classificationKinds = [
  "absent",
  "mentioned",
  "shortlisted",
  "recommended",
  "first_choice",
  "rejected",
] as const;
export type ClassificationKind = (typeof classificationKinds)[number];

export type CitationInput = {
  url: string;
  title?: string;
  position?: number;
};

export type ProviderCaptureRequest = {
  workspaceId: string;
  projectId: string;
  runId: string;
  jobId: string;
  questionId: string;
  prompt: string;
  locale: string;
  market: string;
  timeoutMs: number;
};

export type ProviderCaptureResult = {
  provider: ProviderKey;
  accessMethod: "api" | "search_api";
  modelOrSurface: string;
  providerRequestId?: string;
  answerText: string;
  citations: CitationInput[];
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  latencyMs: number;
  capturedAt: string;
  rawResponse: unknown;
};

export type ProviderFailureCode =
  | "unavailable"
  | "authentication"
  | "rate_limited"
  | "timeout"
  | "malformed_response"
  | "provider_error";

export type ClassificationResult = {
  brandId: string;
  mentioned: boolean;
  cited: boolean;
  explicitlyRecommended: boolean;
  firstChoice: boolean;
  rejected: boolean;
  confidence: number;
  rank: number | null;
  evidenceSpans: Array<{
    start: number;
    end: number;
    text: string;
    kind: "brand" | "recommendation" | "first_choice" | "rejection";
  }>;
  rationale: string;
  classifierName: string;
  classifierVersion: string;
  requiresReview: boolean;
};

export type MetricValue = {
  key:
    | "capture_coverage"
    | "mention_rate"
    | "mention_share"
    | "recommendation_rate"
    | "recommendation_share"
    | "first_choice_rate"
    | "owned_citation_rate"
    | "evidence_support_rate";
  numerator: number;
  denominator: number;
  value: number | null;
  metricVersion: string;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
};

export type WebhookEventName =
  | "run.started"
  | "run.completed"
  | "run.partial"
  | "run.failed"
  | "review.required"
  | "action.created"
  | "action.completed";

export type WebhookEnvelope<T = unknown> = {
  id: string;
  event: WebhookEventName;
  createdAt: string;
  workspaceId: string;
  data: T;
};
