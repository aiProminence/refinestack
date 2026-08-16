import type { ProviderKey, WorkspaceRole } from "@/types/contracts";
import type { Json } from "@/types/database";
import { validateQuestionDraft } from "@/lib/ai/questions";
import { DatabaseContractError, databaseFailure } from "./errors";
import type {
  ClassificationFacts, DbContext, PendingClassificationReview, ProductDbClient,
  ProductSnapshot, ProviderBudgetAssumption, ProviderHealth, QuestionSetSummary, RunPreflight, RunSummary, UsageSummary,
} from "./types";

const roleRank: Record<WorkspaceRole, number> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };
const providerKeys: ProviderKey[] = ["openai", "claude", "google_ai_overview"];

async function requireMembership(ctx: DbContext, minimum: WorkspaceRole = "viewer") {
  const { data, error } = await ctx.client.from("workspace_members")
    .select("role").eq("workspace_id", ctx.actor.workspaceId).eq("user_id", ctx.actor.userId).maybeSingle();
  if (error) databaseFailure("Unable to verify workspace membership.", error);
  if (!data) throw new DatabaseContractError("Workspace membership is required.", "UNAUTHORIZED");
  if (data.role !== ctx.actor.role) {
    throw new DatabaseContractError("Workspace role is stale; refresh the session context.", "UNAUTHORIZED");
  }
  if (roleRank[data.role] < roleRank[minimum]) {
    throw new DatabaseContractError(`This operation requires ${minimum} access.`, "FORBIDDEN");
  }
  return data.role;
}

async function requireProject(ctx: DbContext, projectId: string) {
  const { data, error } = await ctx.client.from("projects").select("id")
    .eq("workspace_id", ctx.actor.workspaceId).eq("id", projectId).maybeSingle();
  if (error) databaseFailure("Unable to authorize the project.", error);
  if (!data) throw new DatabaseContractError("Project was not found in this workspace.", "NOT_FOUND");
}

function rowsOrThrow<T>(data: T[] | null, error: unknown, message: string): T[] {
  if (error) databaseFailure(message, error);
  return data ?? [];
}

export async function listProjects(ctx: DbContext) {
  await requireMembership(ctx);
  const { data, error } = await ctx.client.from("projects").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).order("updated_at", { ascending: false });
  return rowsOrThrow(data, error, "Unable to list projects.");
}

export async function getProject(ctx: DbContext, id: string) {
  await requireMembership(ctx);
  const { data, error } = await ctx.client.from("projects").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("id", id).maybeSingle();
  if (error) databaseFailure("Unable to load the project.", error);
  if (!data) throw new DatabaseContractError("Project was not found in this workspace.", "NOT_FOUND");
  return data;
}

export async function listQuestions(ctx: DbContext, projectId: string) {
  await requireMembership(ctx); await requireProject(ctx, projectId);
  const { data, error } = await ctx.client.from("questions").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .order("updated_at", { ascending: false });
  return rowsOrThrow(data, error, "Unable to list questions.");
}

export async function listBrands(ctx: DbContext, projectId: string) {
  await requireMembership(ctx); await requireProject(ctx, projectId);
  const { data, error } = await ctx.client.from("brands").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .order("created_at", { ascending: true });
  return rowsOrThrow(data, error, "Unable to list brands.");
}

export async function listEvidence(ctx: DbContext, projectId: string) {
  await requireMembership(ctx); await requireProject(ctx, projectId);
  const { data, error } = await ctx.client.from("sources").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .order("updated_at", { ascending: false });
  return rowsOrThrow(data, error, "Unable to list evidence.");
}

export async function listRuns(ctx: DbContext, projectId: string) {
  await requireMembership(ctx); await requireProject(ctx, projectId);
  const { data, error } = await ctx.client.from("runs").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .order("created_at", { ascending: false });
  return rowsOrThrow(data, error, "Unable to list monitoring runs.");
}

export async function getRun(ctx: DbContext, id: string) {
  await requireMembership(ctx);
  const { data, error } = await ctx.client.from("runs").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("id", id).maybeSingle();
  if (error) databaseFailure("Unable to load the monitoring run.", error);
  if (!data) throw new DatabaseContractError("Monitoring run was not found in this workspace.", "NOT_FOUND");
  return data;
}

export async function listObservations(ctx: DbContext, input: { projectId: string; runId?: string }) {
  await requireMembership(ctx); await requireProject(ctx, input.projectId);
  let query = ctx.client.from("observations").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", input.projectId)
    .order("captured_at", { ascending: false });
  if (input.runId) query = query.eq("run_id", input.runId);
  const { data, error } = await query;
  return rowsOrThrow(data, error, "Unable to list observations.");
}

export async function listActions(ctx: DbContext, projectId: string) {
  await requireMembership(ctx); await requireProject(ctx, projectId);
  const { data, error } = await ctx.client.from("actions").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .order("updated_at", { ascending: false });
  return rowsOrThrow(data, error, "Unable to list actions.");
}

export async function listSchedules(ctx: DbContext, projectId: string) {
  await requireMembership(ctx); await requireProject(ctx, projectId);
  const { data, error } = await ctx.client.from("schedules").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .order("created_at", { ascending: false });
  return rowsOrThrow(data, error, "Unable to list schedules.");
}

export async function getProviderHealth(ctx: DbContext): Promise<ProviderHealth[]> {
  await requireMembership(ctx);
  const { data, error } = await ctx.client.from("provider_connections")
    .select("provider,enabled,health_state,remediation,last_checked_at")
    .eq("workspace_id", ctx.actor.workspaceId);
  const configured = rowsOrThrow(data, error, "Unable to load provider health.");
  return providerKeys.map((provider) => {
    const row = configured.find((item) => item.provider === provider);
    return {
      provider, configured: Boolean(row), enabled: row?.enabled ?? false,
      state: row?.health_state as ProviderHealth["state"] ?? "unavailable",
      remediation: row?.remediation ?? (row ? null : "Configure this provider on the server."),
      lastCheckedAt: row?.last_checked_at ?? null,
    };
  });
}

async function loadQuestionSets(ctx: DbContext, projectId: string): Promise<QuestionSetSummary[]> {
  const setsResult = await ctx.client.from("question_sets")
    .select("id,name,version,cohort_hash,created_at")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .order("created_at", { ascending: false });
  const sets = rowsOrThrow(setsResult.data, setsResult.error, "Unable to list question sets.");
  if (sets.length === 0) return [];

  const itemsResult = await ctx.client.from("question_set_items")
    .select("question_set_id,question_version_id,position")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .in("question_set_id", sets.map((set) => set.id))
    .order("position", { ascending: true });
  const items = rowsOrThrow(itemsResult.data, itemsResult.error, "Unable to load question-set items.");
  return sets.map((set) => ({
    id: set.id,
    name: set.name,
    version: set.version,
    cohortHash: set.cohort_hash,
    createdAt: set.created_at,
    questionVersionIds: items
      .filter((item) => item.question_set_id === set.id)
      .map((item) => item.question_version_id),
  }));
}

export async function listQuestionSets(ctx: DbContext, projectId: string): Promise<QuestionSetSummary[]> {
  await requireMembership(ctx); await requireProject(ctx, projectId);
  return loadQuestionSets(ctx, projectId);
}

export async function getRunPreflight(ctx: DbContext, projectId: string): Promise<RunPreflight> {
  await requireMembership(ctx); await requireProject(ctx, projectId);
  const monthStart = new Date();
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [questionsResult, providerResult, budgetResult, usageResult, quotaResult, reservationResult, questionSets] = await Promise.all([
    ctx.client.from("questions").select("id,current_version,current_prompt,question_type,persona,stage,market,locale,rationale")
      .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
      .eq("active", true).eq("state", "active"),
    ctx.client.from("provider_connections")
      .select("provider,enabled,health_state,remediation,last_checked_at")
      .eq("workspace_id", ctx.actor.workspaceId),
    ctx.client.from("provider_budget_caps")
      .select("provider,max_calls_per_capture,max_cost_per_capture_usd,rationale,updated_at"),
    ctx.client.from("usage_events").select("call_count,estimated_cost_usd")
      .eq("workspace_id", ctx.actor.workspaceId)
      .gte("occurred_at", monthStart.toISOString()),
    ctx.client.from("workspace_quotas").select("monthly_call_limit,monthly_cost_limit_usd")
      .eq("workspace_id", ctx.actor.workspaceId).maybeSingle(),
    ctx.client.from("runs").select("reserved_call_count,reserved_cost_usd")
      .eq("workspace_id", ctx.actor.workspaceId).in("status", ["queued", "running"]),
    loadQuestionSets(ctx, projectId),
  ]);
  const questions = rowsOrThrow(questionsResult.data, questionsResult.error, "Unable to load active questions for preflight.");
  const connections = rowsOrThrow(providerResult.data, providerResult.error, "Unable to load provider availability for preflight.");
  const budgetRows = rowsOrThrow(budgetResult.data, budgetResult.error, "Unable to load authoritative provider budget caps for preflight.");
  const usageEvents = rowsOrThrow(usageResult.data, usageResult.error, "Unable to load usage for preflight.");
  if (quotaResult.error) databaseFailure("Unable to load quota for preflight.", quotaResult.error);
  const reservations = rowsOrThrow(reservationResult.data, reservationResult.error, "Unable to load reserved calls for preflight.");
  const invalidQuestionIds = questions.flatMap((question) => {
    const validation = validateQuestionDraft({
      prompt: question.current_prompt,
      questionType: question.question_type,
      persona: question.persona ?? "",
      stage: question.stage ?? "",
      market: question.market,
      locale: question.locale,
      rationale: question.rationale ?? "",
    }, {
      knownQuestions: questions.filter(({ id }) => id !== question.id)
        .map(({ id, current_prompt }) => ({ id, prompt: current_prompt })),
    });
    return validation.issues.length ? [question.id] : [];
  });

  let activeQuestionVersionIds: string[] = [];
  if (questions.length > 0) {
    const versionResult = await ctx.client.from("question_versions")
      .select("id,question_id,version")
      .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
      .in("question_id", questions.map((question) => question.id));
    const versions = rowsOrThrow(versionResult.data, versionResult.error, "Unable to resolve current question versions.");
    const currentVersionByQuestion = new Map(questions.map((question) => [question.id, question.current_version]));
    activeQuestionVersionIds = versions
      .filter((version) => currentVersionByQuestion.get(version.question_id) === version.version)
      .map((version) => version.id)
      .sort();
    if (activeQuestionVersionIds.length !== questions.length) {
      databaseFailure("An active question is missing its current immutable version.", {
        activeQuestionCount: questions.length,
        resolvedVersionCount: activeQuestionVersionIds.length,
      });
    }
  }

  const providers = providerKeys.map<ProviderHealth>((provider) => {
    const row = connections.find((connection) => connection.provider === provider);
    const state = row?.health_state;
    return {
      provider,
      configured: Boolean(row),
      enabled: row?.enabled ?? false,
      state: state === "unchecked" || state === "healthy" || state === "degraded" || state === "unavailable"
        ? state : "unavailable",
      remediation: row?.remediation ?? (row ? null : "Configure this provider on the server."),
      lastCheckedAt: row?.last_checked_at ?? null,
    };
  });
  const selectedProviderKeys = providers
    .filter((provider) => provider.enabled && (provider.state === "healthy" || provider.state === "unchecked"))
    .map((provider) => provider.provider);
  const estimatedCaptureCount = activeQuestionVersionIds.length * selectedProviderKeys.length;
  const budgetByProvider = new Map<ProviderKey, ProviderBudgetAssumption>();
  for (const row of budgetRows) {
    const maxCallsPerCapture = Number(row.max_calls_per_capture);
    const maxCostPerCaptureUsd = Number(row.max_cost_per_capture_usd);
    if (!providerKeys.includes(row.provider) || !Number.isInteger(maxCallsPerCapture) || maxCallsPerCapture < 1
      || !Number.isFinite(maxCostPerCaptureUsd) || maxCostPerCaptureUsd <= 0) continue;
    budgetByProvider.set(row.provider, {
      provider: row.provider,
      maxCallsPerCapture,
      maxCostPerCaptureUsd,
      rationale: row.rationale,
      updatedAt: row.updated_at,
    });
  }
  const providerBudgetAssumptions = selectedProviderKeys
    .flatMap((provider) => {
      const budget = budgetByProvider.get(provider);
      return budget ? [budget] : [];
    });
  const providersMissingBudgetCaps = selectedProviderKeys
    .filter((provider) => !budgetByProvider.has(provider));
  const requiredCalls = activeQuestionVersionIds.length * providerBudgetAssumptions
    .reduce((total, budget) => total + budget.maxCallsPerCapture, 0);
  const requiredCostUsd = Number((activeQuestionVersionIds.length * providerBudgetAssumptions
    .reduce((total, budget) => total + budget.maxCostPerCaptureUsd, 0)).toFixed(6));
  const callsUsed = usageEvents.reduce((total, event) => total + event.call_count, 0)
    + reservations.reduce((total, run) => total + run.reserved_call_count, 0);
  const costUsedUsd = Number((usageEvents.reduce((total, event) => total + Number(event.estimated_cost_usd), 0)
    + reservations.reduce((total, run) => total + Number(run.reserved_cost_usd), 0)).toFixed(6));
  const callLimit = quotaResult.data?.monthly_call_limit ?? null;
  const costLimitUsd = quotaResult.data ? Number(quotaResult.data.monthly_cost_limit_usd) : null;
  const callsRemaining = callLimit === null ? null : Math.max(0, callLimit - callsUsed);
  const costRemainingUsd = costLimitUsd === null ? null : Number(Math.max(0, costLimitUsd - costUsedUsd).toFixed(6));
  const callShortfall = callsRemaining === null ? requiredCalls : Math.max(0, requiredCalls - callsRemaining);
  const costShortfallUsd = costRemainingUsd === null
    ? requiredCostUsd
    : Number(Math.max(0, requiredCostUsd - costRemainingUsd).toFixed(6));
  const callsInsufficient = callsRemaining !== null && callShortfall > 0;
  const costInsufficient = costRemainingUsd !== null && costShortfallUsd > 0;
  const reason = activeQuestionVersionIds.length === 0 ? "no_active_questions"
    : invalidQuestionIds.length > 0 ? "invalid_question_quality"
      : selectedProviderKeys.length === 0 ? "no_available_provider"
      : providersMissingBudgetCaps.length > 0 ? "provider_budget_unavailable"
        : callLimit === null || costLimitUsd === null ? "quota_not_configured"
          : callsInsufficient && costInsufficient ? "insufficient_calls_and_cost"
            : callsInsufficient ? "insufficient_calls"
              : costInsufficient ? "insufficient_cost" : null;
  const activeCohort = [...activeQuestionVersionIds].sort();
  const activeQuestionSetId = activeCohort.length === 0 ? null : questionSets.find((set) => {
    const setCohort = [...set.questionVersionIds].sort();
    return setCohort.length === activeCohort.length
      && setCohort.every((versionId, index) => versionId === activeCohort[index]);
  })?.id ?? null;

  return {
    projectId,
    activeQuestionVersionIds,
    activeQuestionSetId,
    providers,
    selectedProviderKeys,
    providerBudgetAssumptions,
    providersMissingBudgetCaps,
    invalidQuestionIds,
    estimatedCaptureCount,
    quota: {
      configured: callLimit !== null && costLimitUsd !== null,
      callsUsed,
      callLimit,
      callsRemaining,
      requiredCalls,
      callShortfall,
      costUsedUsd,
      costLimitUsd,
      costRemainingUsd,
      requiredCostUsd,
      costShortfallUsd,
      ready: reason === null,
      reason,
    },
  };
}

export async function listPendingClassificationReviews(
  ctx: DbContext,
  projectId: string,
): Promise<PendingClassificationReview[]> {
  await requireMembership(ctx); await requireProject(ctx, projectId);
  const classificationResult = await ctx.client.from("brand_classifications")
    .select("id,brand_version_id,observation_id,mentioned,cited,shortlisted,explicitly_recommended,first_choice,rejected,rank,confidence,evidence_spans,rationale")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .eq("review_status", "pending").order("created_at", { ascending: true });
  const classifications = rowsOrThrow(
    classificationResult.data,
    classificationResult.error,
    "Unable to list pending classification reviews.",
  );
  if (classifications.length === 0) return [];

  const reviewedResult = await ctx.client.from("classification_reviews")
    .select("classification_id").eq("workspace_id", ctx.actor.workspaceId)
    .eq("project_id", projectId).in("classification_id", classifications.map((classification) => classification.id));
  const reviewed = rowsOrThrow(reviewedResult.data, reviewedResult.error, "Unable to resolve completed classification reviews.");
  const reviewedIds = new Set(reviewed.map((review) => review.classification_id));
  const pendingClassifications = classifications.filter((classification) => !reviewedIds.has(classification.id));
  if (pendingClassifications.length === 0) return [];

  const observationResult = await ctx.client.from("observations")
    .select("id,answer_text,provider,access_method,model_or_surface,captured_at")
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .in("id", [...new Set(pendingClassifications.map((classification) => classification.observation_id))]);
  const observations = rowsOrThrow(
    observationResult.data,
    observationResult.error,
    "Unable to load observation evidence for pending reviews.",
  );
  const observationsById = new Map(observations.map((observation) => [observation.id, observation]));

  return pendingClassifications.map((classification) => {
    const observation = observationsById.get(classification.observation_id);
    if (!observation) {
      databaseFailure("A pending classification is missing its tenant-scoped observation.", {
        classificationId: classification.id,
      });
    }
    const facts: ClassificationFacts = {
      mentioned: classification.mentioned,
      cited: classification.cited,
      shortlisted: classification.shortlisted,
      explicitlyRecommended: classification.explicitly_recommended,
      firstChoice: classification.first_choice,
      rejected: classification.rejected,
      rank: classification.rank,
    };
    return {
      classificationId: classification.id,
      brandVersionId: classification.brand_version_id,
      facts,
      confidence: Number(classification.confidence),
      rationale: classification.rationale,
      evidenceSpans: Array.isArray(classification.evidence_spans) ? classification.evidence_spans : [],
      observation: {
        id: observation.id,
        answerText: observation.answer_text,
        provider: observation.provider,
        accessMethod: observation.access_method,
        modelOrSurface: observation.model_or_surface,
        capturedAt: observation.captured_at,
      },
      beforeValue: { ...facts },
    };
  });
}

export async function getUsageSummary(ctx: DbContext, projectId: string): Promise<UsageSummary> {
  await requireMembership(ctx); await requireProject(ctx, projectId);
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [usage, reservations, quota] = await Promise.all([
    ctx.client.from("usage_events").select("call_count,input_tokens,output_tokens,estimated_cost_usd,usage_complete,billing_ambiguous")
      .eq("workspace_id", ctx.actor.workspaceId)
      .gte("occurred_at", monthStart.toISOString()),
    ctx.client.from("runs").select("reserved_call_count,reserved_cost_usd")
      .eq("workspace_id", ctx.actor.workspaceId).in("status", ["queued", "running"]),
    ctx.client.from("workspace_quotas").select("monthly_call_limit,monthly_cost_limit_usd")
      .eq("workspace_id", ctx.actor.workspaceId).maybeSingle(),
  ]);
  const events = rowsOrThrow(usage.data, usage.error, "Unable to calculate usage.");
  const activeReservations = rowsOrThrow(reservations.data, reservations.error, "Unable to calculate active reservations.");
  if (quota.error) databaseFailure("Unable to load workspace quota.", quota.error);
  const totals = events.reduce<UsageSummary>((summary, event) => ({
    ...summary,
    calls: summary.calls + event.call_count,
    inputTokens: summary.inputTokens + event.input_tokens,
    outputTokens: summary.outputTokens + event.output_tokens,
    estimatedCostUsd: summary.estimatedCostUsd + Number(event.estimated_cost_usd),
    ambiguousEventCount: summary.ambiguousEventCount + (event.billing_ambiguous ? 1 : 0),
    incompleteEventCount: summary.incompleteEventCount + (event.usage_complete ? 0 : 1),
    ambiguousCallCount: summary.ambiguousCallCount + (event.billing_ambiguous ? event.call_count : 0),
  }), {
    calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
    reservedCalls: 0, reservedCostUsd: 0,
    callLimit: quota.data?.monthly_call_limit ?? 0,
    costLimitUsd: Number(quota.data?.monthly_cost_limit_usd ?? 0),
    ambiguousEventCount: 0, incompleteEventCount: 0, ambiguousCallCount: 0,
  });
  return activeReservations.reduce<UsageSummary>((summary, run) => ({
    ...summary,
    reservedCalls: summary.reservedCalls + run.reserved_call_count,
    reservedCostUsd: summary.reservedCostUsd + Number(run.reserved_cost_usd),
  }), totals);
}

export async function listWorkspaceMembers(ctx: DbContext) {
  await requireMembership(ctx);
  const { data, error } = await ctx.client.from("workspace_members").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).order("created_at");
  return rowsOrThrow(data, error, "Unable to list workspace members.");
}

export async function listInvitations(ctx: DbContext) {
  await requireMembership(ctx, "admin");
  const { data, error } = await ctx.client.from("workspace_invitations").select("*")
    .eq("workspace_id", ctx.actor.workspaceId).order("created_at", { ascending: false });
  return rowsOrThrow(data, error, "Unable to list workspace invitations.");
}

export async function getProductSnapshot(ctx: DbContext): Promise<ProductSnapshot> {
  await requireMembership(ctx);
  const [workspaceResult, projects, questionsResult, sourcesResult, runsResult, actionsResult, reviewResult, providers] = await Promise.all([
    ctx.client.from("workspaces").select("id,name,slug").eq("id", ctx.actor.workspaceId).maybeSingle(),
    ctx.client.from("projects").select("*").eq("workspace_id", ctx.actor.workspaceId).order("updated_at", { ascending: false }),
    ctx.client.from("questions").select("id,project_id").eq("workspace_id", ctx.actor.workspaceId),
    ctx.client.from("sources").select("id,project_id").eq("workspace_id", ctx.actor.workspaceId),
    ctx.client.from("runs").select("id,project_id,status,requested_capture_count,created_at,started_at,completed_at").eq("workspace_id", ctx.actor.workspaceId).order("created_at", { ascending: false }).limit(5),
    ctx.client.from("actions").select("id,project_id").eq("workspace_id", ctx.actor.workspaceId),
    ctx.client.from("brand_classifications").select("id").eq("workspace_id", ctx.actor.workspaceId).eq("review_status", "pending"),
    getProviderHealth(ctx),
  ]);
  if (workspaceResult.error || !workspaceResult.data) databaseFailure("Unable to load the workspace.", workspaceResult.error);
  const projectRows = rowsOrThrow(projects.data, projects.error, "Unable to load projects.");
  const questionRows = rowsOrThrow(questionsResult.data, questionsResult.error, "Unable to count questions.");
  const sourceRows = rowsOrThrow(sourcesResult.data, sourcesResult.error, "Unable to count evidence.");
  const runRows = rowsOrThrow(runsResult.data, runsResult.error, "Unable to load recent runs.");
  const actionRows = rowsOrThrow(actionsResult.data, actionsResult.error, "Unable to count actions.");
  if (reviewResult.error) databaseFailure("Unable to count pending reviews.", reviewResult.error);
  const pendingClassificationIds = (reviewResult.data ?? []).map((classification) => classification.id);
  let pendingReviewCount = pendingClassificationIds.length;
  if (pendingClassificationIds.length) {
    const reviewed = await ctx.client.from("classification_reviews").select("classification_id")
      .eq("workspace_id", ctx.actor.workspaceId).in("classification_id", pendingClassificationIds);
    if (reviewed.error) databaseFailure("Unable to resolve completed reviews.", reviewed.error);
    pendingReviewCount -= new Set((reviewed.data ?? []).map((review) => review.classification_id)).size;
  }
  const primaryProject = projectRows[0];
  let brandRows: Array<{ role: "primary" | "competitor" }> = [];
  if (primaryProject) {
    const brands = await ctx.client.from("brands").select("role")
      .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", primaryProject.id);
    brandRows = rowsOrThrow(brands.data, brands.error, "Unable to evaluate setup.");
  }
  const missing: ProductSnapshot["setup"]["missing"] = [];
  if (!primaryProject) missing.push("project");
  if (primaryProject && !primaryProject.domain) missing.push("domain");
  if (primaryProject && !primaryProject.category) missing.push("category");
  if (!brandRows.some((brand) => brand.role === "primary")) missing.push("primary_brand");
  if (!brandRows.some((brand) => brand.role === "competitor")) missing.push("competitor");
  if (primaryProject && !questionRows.some((question) => question.project_id === primaryProject.id)) missing.push("question");
  const usage = primaryProject ? await getUsageSummary(ctx, primaryProject.id) : {
    calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
    reservedCalls: 0, reservedCostUsd: 0, callLimit: 0, costLimitUsd: 0,
    ambiguousEventCount: 0, incompleteEventCount: 0, ambiguousCallCount: 0,
  };
  return {
    actor: ctx.actor,
    workspace: workspaceResult.data,
    setup: { complete: missing.length === 0, missing },
    counts: { projects: projectRows.length, questions: questionRows.length, evidence: sourceRows.length, runs: runRows.length, actions: actionRows.length },
    providers, usage,
    recentRuns: runRows.map<RunSummary>((run) => ({ id: run.id, projectId: run.project_id, status: run.status, requestedCaptureCount: run.requested_capture_count, createdAt: run.created_at, startedAt: run.started_at, completedAt: run.completed_at })),
    pendingReviewCount,
  };
}

export async function createProject(ctx: DbContext, input: { name: string; domain?: string; category?: string; market: string; locale: string; languages: string[] }) {
  await requireMembership(ctx, "analyst");
  const { data, error } = await ctx.client.from("projects").insert({ workspace_id: ctx.actor.workspaceId, created_by: ctx.actor.userId, name: input.name, domain: input.domain ?? null, category: input.category ?? null, default_market: input.market, default_locale: input.locale, languages: input.languages, status: "draft" }).select("*").single();
  if (error) databaseFailure("Unable to create the project.", error); return data;
}

export async function updateProject(ctx: DbContext, id: string, input: Partial<{ name: string; domain: string | null; category: string | null; default_market: string; default_locale: string; languages: string[]; status: "draft" | "active" | "archived" }>) {
  await requireMembership(ctx, "analyst"); await requireProject(ctx, id);
  const { data, error } = await ctx.client.from("projects").update(input).eq("workspace_id", ctx.actor.workspaceId).eq("id", id).select("*").single();
  if (error) databaseFailure("Unable to update the project.", error); return data;
}

export async function createBrand(ctx: DbContext, input: {
  projectId: string;
  name: string;
  domain: string;
  role: "primary" | "competitor";
  market: string;
}) {
  await requireMembership(ctx, "analyst"); await requireProject(ctx, input.projectId);
  const { data, error } = await ctx.client.from("brands").insert({
    workspace_id: ctx.actor.workspaceId,
    project_id: input.projectId,
    name: input.name,
    domain: input.domain,
    role: input.role,
    is_primary: input.role === "primary",
    market: input.market,
  }).select("*").single();
  if (error) databaseFailure("Unable to create the brand.", error);
  return data;
}

export async function updateBrand(ctx: DbContext, id: string, input: Partial<{
  name: string;
  domain: string;
  role: "primary" | "competitor";
  market: string;
}>) {
  await requireMembership(ctx, "analyst");
  const existing = await ctx.client.from("brands").select("id")
    .eq("workspace_id", ctx.actor.workspaceId).eq("id", id).maybeSingle();
  if (existing.error) databaseFailure("Unable to authorize the brand.", existing.error);
  if (!existing.data) throw new DatabaseContractError("Brand was not found in this workspace.", "NOT_FOUND");
  const update = input.role === undefined ? input : { ...input, is_primary: input.role === "primary" };
  const { data, error } = await ctx.client.from("brands").update(update)
    .eq("workspace_id", ctx.actor.workspaceId).eq("id", id).select("*").maybeSingle();
  if (error) databaseFailure("Unable to update the brand.", error);
  if (!data) throw new DatabaseContractError("Brand was not found in this workspace.", "NOT_FOUND");
  return data;
}

export async function createQuestion(ctx: DbContext, input: { projectId: string; prompt: string; market: string; locale: string; questionType: string; persona?: string; stage?: string; rationale?: string }) {
  await requireMembership(ctx, "analyst"); await requireProject(ctx, input.projectId);
  const { data, error } = await ctx.client.from("questions").insert({ workspace_id: ctx.actor.workspaceId, project_id: input.projectId, current_prompt: input.prompt, market: input.market, locale: input.locale, question_type: input.questionType, persona: input.persona ?? null, stage: input.stage ?? null, rationale: input.rationale ?? null, created_by: ctx.actor.userId }).select("*").single();
  if (error) databaseFailure("Unable to create the question.", error); return data;
}

export async function updateQuestion(ctx: DbContext, id: string, input: Partial<{ current_prompt: string; market: string; locale: string; question_type: string; persona: string | null; stage: string | null; rationale: string | null; state: "active" | "disqualified" | "archived"; disqualification_reason: string | null }>) {
  await requireMembership(ctx, "analyst");
  const { data: existing, error: existingError } = await ctx.client.from("questions").select("id").eq("workspace_id", ctx.actor.workspaceId).eq("id", id).maybeSingle();
  if (existingError) databaseFailure("Unable to authorize the question.", existingError); if (!existing) throw new DatabaseContractError("Question was not found in this workspace.", "NOT_FOUND");
  const { data, error } = await ctx.client.from("questions").update(input).eq("workspace_id", ctx.actor.workspaceId).eq("id", id).select("*").single();
  if (error) databaseFailure("Unable to update the question.", error); return data;
}

export async function createSource(ctx: DbContext, input: { projectId: string; kind: "url" | "text" | "file"; name: string; originalUrl?: string; canonicalUrl?: string; contentText?: string; storagePath?: string; contentHash: string; mimeType?: string; retrievedAt?: string; retrievalMetadata?: Json; policy?: Partial<{ retrievalAllowed: boolean; quotingAllowed: boolean; exportAllowed: boolean }> }) {
  await requireMembership(ctx, "analyst"); await requireProject(ctx, input.projectId);
  const created = await ctx.client.rpc("create_evidence_source", {
    p_workspace_id: ctx.actor.workspaceId, p_project_id: input.projectId,
    p_actor_id: ctx.actor.userId, p_kind: input.kind, p_name: input.name,
    p_original_url: input.originalUrl ?? null, p_canonical_url: input.canonicalUrl ?? null,
    p_content_text: input.contentText ?? null, p_storage_path: input.storagePath ?? null,
    p_content_hash: input.contentHash, p_mime_type: input.mimeType ?? null,
    p_retrieved_at: input.retrievedAt ?? null, p_retrieval_metadata: input.retrievalMetadata ?? {},
    p_retrieval_allowed: input.policy?.retrievalAllowed ?? true,
    p_quoting_allowed: input.policy?.quotingAllowed ?? true,
    p_export_allowed: input.policy?.exportAllowed ?? true,
  });
  if (created.error) databaseFailure("Unable to create the evidence source and immutable version.", created.error);
  const [source, version] = await Promise.all([
    ctx.client.from("sources").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", input.projectId).eq("id", created.data).single(),
    ctx.client.from("source_versions").select("*").eq("workspace_id", ctx.actor.workspaceId).eq("project_id", input.projectId).eq("source_id", created.data).eq("version", 1).single(),
  ]);
  if (source.error || version.error) databaseFailure("The created evidence source could not be loaded.", source.error ?? version.error);
  return { source: source.data, version: version.data };
}

export async function requestRun(ctx: DbContext, input: { projectId: string; questionVersionIds: string[]; providers: ProviderKey[]; idempotencyKey: string; estimatedMaxCostUsd?: number }) {
  await requireMembership(ctx, "analyst"); await requireProject(ctx, input.projectId);
  const { data, error } = await ctx.client.rpc("create_monitoring_run", { p_workspace_id: ctx.actor.workspaceId, p_project_id: input.projectId, p_actor_id: ctx.actor.userId, p_question_version_ids: input.questionVersionIds, p_providers: input.providers, p_idempotency_key: input.idempotencyKey, p_estimated_max_cost_usd: input.estimatedMaxCostUsd ?? null });
  if (error) databaseFailure("Unable to request the monitoring run.", error); return data;
}

export async function createQuestionSet(ctx: DbContext, input: { projectId: string; name: string; questionVersionIds: string[] }): Promise<QuestionSetSummary> {
  await requireMembership(ctx, "analyst"); await requireProject(ctx, input.projectId);
  const uniqueIds = new Set(input.questionVersionIds);
  if (uniqueIds.size === 0 || uniqueIds.size !== input.questionVersionIds.length) {
    throw new DatabaseContractError("Question sets require unique question versions.", "CONFLICT");
  }
  const { data, error } = await ctx.client.rpc("create_question_set", {
    p_workspace_id: ctx.actor.workspaceId,
    p_project_id: input.projectId,
    p_actor_id: ctx.actor.userId,
    p_name: input.name,
    p_question_version_ids: input.questionVersionIds,
  });
  if (error) databaseFailure("Unable to create the immutable question set.", error);
  const sets = await listQuestionSets(ctx, input.projectId);
  const created = sets.find((set) => set.id === data);
  if (!created) throw new DatabaseContractError("The created question set could not be loaded.", "NOT_FOUND");
  return created;
}

export async function createSchedule(ctx: DbContext, input: { projectId: string; questionSetId: string; providers: ProviderKey[]; name: string; frequency: "daily" | "weekly" | "monthly"; timezone: string; localTime: string; overlapPolicy: "skip" | "queue"; nextRunAt: string }) {
  await requireMembership(ctx, "admin"); await requireProject(ctx, input.projectId);
  const { data, error } = await ctx.client.from("schedules").insert({ workspace_id: ctx.actor.workspaceId, project_id: input.projectId, question_set_id: input.questionSetId, providers: input.providers, name: input.name, frequency: input.frequency, timezone: input.timezone, local_time: input.localTime, overlap_policy: input.overlapPolicy, next_run_at: input.nextRunAt, created_by: ctx.actor.userId }).select("*").single();
  if (error) databaseFailure("Unable to create the schedule.", error); return data;
}

export async function updateSchedule(ctx: DbContext, id: string, input: Partial<{ name: string; providers: ProviderKey[]; frequency: "daily" | "weekly" | "monthly"; timezone: string; local_time: string; overlap_policy: "skip" | "queue"; enabled: boolean; next_run_at: string | null }>) {
  await requireMembership(ctx, "admin");
  const { data, error } = await ctx.client.from("schedules").update(input).eq("workspace_id", ctx.actor.workspaceId).eq("id", id).select("*").maybeSingle();
  if (error) databaseFailure("Unable to update the schedule.", error); if (!data) throw new DatabaseContractError("Schedule was not found in this workspace.", "NOT_FOUND"); return data;
}

export async function resetScheduleCircuit(ctx: DbContext, projectId: string, scheduleId: string) {
  await requireMembership(ctx, "admin");
  await requireProject(ctx, projectId);
  const { data, error } = await ctx.client.rpc("reset_schedule_circuit", {
    p_workspace_id: ctx.actor.workspaceId,
    p_project_id: projectId,
    p_schedule_id: scheduleId,
    p_actor_id: ctx.actor.userId,
  });
  if (error) databaseFailure("Unable to reset the schedule circuit.", error);
  return data;
}

export async function submitClassificationReview(ctx: DbContext, input: { projectId: string; classificationId: string; decision: "approved" | "overridden"; reason: string; afterValue: Json }) {
  await requireMembership(ctx, "analyst"); await requireProject(ctx, input.projectId);
  const { data, error } = await ctx.client.rpc("submit_classification_review", { p_workspace_id: ctx.actor.workspaceId, p_project_id: input.projectId, p_actor_id: ctx.actor.userId, p_classification_id: input.classificationId, p_decision: input.decision, p_reason: input.reason, p_after_value: input.afterValue });
  if (error) databaseFailure("Unable to submit the classification review.", error); return data;
}

export async function createInvitation(ctx: DbContext, input: { email: string; role: WorkspaceRole; expiresAt: string; signupProofHash: string }) {
  await requireMembership(ctx, input.role === "owner" ? "owner" : "admin");
  const { data, error } = await ctx.client.from("workspace_invitations").insert({ workspace_id: ctx.actor.workspaceId, invitation_kind: "workspace", email: input.email.trim().toLowerCase(), role: input.role, expires_at: input.expiresAt, invited_by: ctx.actor.userId, signup_proof_hash: input.signupProofHash }).select("*").single();
  if (error) databaseFailure("Unable to store the workspace invitation before sending the Supabase admin invite email.", error); return data;
}

export async function createBootstrapInvitation(input: { client: DbContext["client"]; email: string; expiresAt: string; signupProofHash: string }) {
  const { data, error } = await input.client.from("workspace_invitations").insert({ workspace_id: null, invitation_kind: "bootstrap", email: input.email.trim().toLowerCase(), role: "owner", expires_at: input.expiresAt, invited_by: null, signup_proof_hash: input.signupProofHash }).select("*").single();
  if (error) databaseFailure("Unable to create the owner bootstrap invitation.", error); return data;
}

export async function bootstrapWorkspace(input: { client: DbContext["client"]; invitationId: string; userId: string; name: string; slug: string; verifiedAt: string }) {
  const { data, error } = await input.client.rpc("bootstrap_workspace_from_invitation", { p_invitation_id: input.invitationId, p_user_id: input.userId, p_name: input.name, p_slug: input.slug, p_verified_at: input.verifiedAt });
  if (error) databaseFailure("Unable to bootstrap the first workspace.", error); return data;
}

export async function revokeInvitation(ctx: DbContext, invitationId: string) {
  await requireMembership(ctx, "admin");
  const { data, error } = await ctx.client.rpc("revoke_workspace_invitation", {
    p_workspace_id: ctx.actor.workspaceId,
    p_actor_id: ctx.actor.userId,
    p_invitation_id: invitationId,
  });
  if (error) databaseFailure("Unable to revoke the invitation.", error);
  return data;
}

export async function acceptInvitationForCurrentUser(client: ProductDbClient, invitationId: string, userId: string, verifiedAt: string) {
  const { data, error } = await client.rpc("accept_workspace_invitation", {
    p_invitation_id: invitationId, p_user_id: userId, p_verified_at: verifiedAt,
  });
  if (error) databaseFailure("Unable to accept the invitation.", error);
  return data;
}

export async function updateMemberRole(ctx: DbContext, userId: string, role: WorkspaceRole) {
  await requireMembership(ctx, role === "owner" ? "owner" : "admin");
  if (userId === ctx.actor.userId) throw new DatabaseContractError("Use ownership transfer to change your own role.", "CONFLICT");
  const target = await ctx.client.from("workspace_members").select("role").eq("workspace_id", ctx.actor.workspaceId).eq("user_id", userId).maybeSingle();
  if (target.error) databaseFailure("Unable to authorize the member role change.", target.error);
  if (!target.data) throw new DatabaseContractError("Member was not found in this workspace.", "NOT_FOUND");
  if (target.data.role === "owner" && ctx.actor.role !== "owner") throw new DatabaseContractError("Only an owner can change another owner's role.", "FORBIDDEN");
  const { data, error } = await ctx.client.from("workspace_members").update({ role }).eq("workspace_id", ctx.actor.workspaceId).eq("user_id", userId).select("*").maybeSingle();
  if (error) databaseFailure("Unable to update the member role.", error); if (!data) throw new DatabaseContractError("Member was not found in this workspace.", "NOT_FOUND"); return data;
}

export async function removeMember(ctx: DbContext, userId: string) {
  await requireMembership(ctx, "admin");
  if (userId === ctx.actor.userId) throw new DatabaseContractError("You cannot remove your own membership.", "CONFLICT");
  const target = await ctx.client.from("workspace_members").select("role").eq("workspace_id", ctx.actor.workspaceId).eq("user_id", userId).maybeSingle();
  if (target.error) databaseFailure("Unable to authorize member removal.", target.error);
  if (!target.data) throw new DatabaseContractError("Member was not found in this workspace.", "NOT_FOUND");
  if (target.data.role === "owner" && ctx.actor.role !== "owner") throw new DatabaseContractError("Only an owner can remove another owner.", "FORBIDDEN");
  const { data, error } = await ctx.client.from("workspace_members").delete().eq("workspace_id", ctx.actor.workspaceId).eq("user_id", userId).select("*").maybeSingle();
  if (error) databaseFailure("Unable to remove the member.", error); if (!data) throw new DatabaseContractError("Member was not found in this workspace.", "NOT_FOUND"); return data;
}

export function createProductRepository(ctx: DbContext) {
  return {
    getProductSnapshot: () => getProductSnapshot(ctx), listProjects: () => listProjects(ctx),
    getProject: (id: string) => getProject(ctx, id), listBrands: (id: string) => listBrands(ctx, id),
    listQuestions: (id: string) => listQuestions(ctx, id),
    listEvidence: (id: string) => listEvidence(ctx, id), listRuns: (id: string) => listRuns(ctx, id),
    getRun: (id: string) => getRun(ctx, id),
    listObservations: (input: { projectId: string; runId?: string }) => listObservations(ctx, input),
    listActions: (id: string) => listActions(ctx, id), listSchedules: (id: string) => listSchedules(ctx, id),
    getProviderHealth: () => getProviderHealth(ctx), getUsageSummary: (id: string) => getUsageSummary(ctx, id),
    listQuestionSets: (id: string) => listQuestionSets(ctx, id),
    getRunPreflight: (id: string) => getRunPreflight(ctx, id),
    listPendingClassificationReviews: (id: string) => listPendingClassificationReviews(ctx, id),
    listWorkspaceMembers: () => listWorkspaceMembers(ctx), listInvitations: () => listInvitations(ctx),
    createProject: (input: Parameters<typeof createProject>[1]) => createProject(ctx, input),
    updateProject: (id: string, input: Parameters<typeof updateProject>[2]) => updateProject(ctx, id, input),
    createBrand: (input: Parameters<typeof createBrand>[1]) => createBrand(ctx, input),
    updateBrand: (id: string, input: Parameters<typeof updateBrand>[2]) => updateBrand(ctx, id, input),
    createQuestion: (input: Parameters<typeof createQuestion>[1]) => createQuestion(ctx, input),
    updateQuestion: (id: string, input: Parameters<typeof updateQuestion>[2]) => updateQuestion(ctx, id, input),
    createSource: (input: Parameters<typeof createSource>[1]) => createSource(ctx, input),
    createQuestionSet: (input: Parameters<typeof createQuestionSet>[1]) => createQuestionSet(ctx, input),
    requestRun: (input: Parameters<typeof requestRun>[1]) => requestRun(ctx, input),
    createSchedule: (input: Parameters<typeof createSchedule>[1]) => createSchedule(ctx, input),
    updateSchedule: (id: string, input: Parameters<typeof updateSchedule>[2]) => updateSchedule(ctx, id, input),
    resetScheduleCircuit: (projectId: string, scheduleId: string) => resetScheduleCircuit(ctx, projectId, scheduleId),
    submitClassificationReview: (input: Parameters<typeof submitClassificationReview>[1]) => submitClassificationReview(ctx, input),
    createInvitation: (input: Parameters<typeof createInvitation>[1]) => createInvitation(ctx, input),
    revokeInvitation: (id: string) => revokeInvitation(ctx, id),
    updateMemberRole: (userId: string, role: WorkspaceRole) => updateMemberRole(ctx, userId, role),
    removeMember: (userId: string) => removeMember(ctx, userId),
  };
}
