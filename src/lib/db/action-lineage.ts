import "server-only";

import { DatabaseContractError, databaseFailure } from "./errors";
import type { DbContext } from "./types";
import type { ActionRow, WorkspaceRole } from "@/types/database";

export type ActionStatus = ActionRow["status"];
export type ActionReferenceKind = "question_version" | "classification" | "source_version";

export type ActionReference = {
  value: `${ActionReferenceKind}:${string}`;
  kind: ActionReferenceKind;
  id: string;
  label: string;
  detail: string;
  createdAt: string;
};

export type ActionEvidenceLink = {
  id: string;
  kind: ActionReferenceKind;
  recordId: string;
  label: string;
  detail: string;
  rationale: string;
  createdAt: string;
};

export type ActionFollowUp = {
  id: string;
  runId: string;
  runStatus: string;
  runCreatedAt: string;
  outcomeNote: string;
  causationAsserted: false;
  linkedAt: string;
};

export type FollowUpRun = {
  id: string;
  status: "succeeded" | "partial";
  createdAt: string;
  completedAt: string;
};

export type ActionWithLineage = ActionRow & {
  evidenceLinks: ActionEvidenceLink[];
  followUps: ActionFollowUp[];
};

type QueryResponse = { data: unknown; error: unknown };
type LineageQuery = PromiseLike<QueryResponse> & {
  select(columns: string): LineageQuery;
  eq(column: string, value: unknown): LineageQuery;
  order(column: string, options?: { ascending?: boolean }): LineageQuery;
};
type LineageClient = {
  from(table: string): LineageQuery;
  rpc(name: string, args: Record<string, unknown>): PromiseLike<QueryResponse>;
};

type QuestionVersionRecord = {
  id: string; version: number; prompt: string; locale: string; created_at: string;
};
type ClassificationRecord = {
  id: string; brand_version_id: string; mentioned: boolean; cited: boolean;
  explicitly_recommended: boolean; first_choice: boolean; rejected: boolean;
  rationale: string; created_at: string;
};
type BrandVersionRecord = { id: string; name: string; version: number };
type SourceVersionRecord = { id: string; source_id: string; version: number; valid_from: string; created_at: string };
type SourceRecord = { id: string; name: string };
type EvidenceLinkRecord = {
  id: string; action_id: string; question_version_id: string | null;
  classification_id: string | null; source_version_id: string | null;
  rationale: string; created_at: string;
};
type RunRecord = {
  id: string; status: string; created_at: string; completed_at: string | null;
};
type FollowUpRecord = {
  id: string; action_id: string; run_id: string; outcome_note: string;
  causation_asserted: boolean; created_at: string;
};

const roleRank: Record<WorkspaceRole, number> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };

function rows<T>(result: QueryResponse, failureMessage: string): T[] {
  if (result.error) databaseFailure(failureMessage, result.error);
  return (result.data ?? []) as T[];
}

async function authorizeProject(ctx: DbContext, projectId: string, minimum: WorkspaceRole = "viewer") {
  const [membership, project] = await Promise.all([
    ctx.client.from("workspace_members").select("role")
      .eq("workspace_id", ctx.actor.workspaceId).eq("user_id", ctx.actor.userId).maybeSingle(),
    ctx.client.from("projects").select("id")
      .eq("workspace_id", ctx.actor.workspaceId).eq("id", projectId).maybeSingle(),
  ]);
  if (membership.error) databaseFailure("Unable to verify action access.", membership.error);
  if (!membership.data || membership.data.role !== ctx.actor.role) {
    throw new DatabaseContractError("Workspace membership is required or stale.", "UNAUTHORIZED");
  }
  if (roleRank[membership.data.role] < roleRank[minimum]) {
    throw new DatabaseContractError(`This operation requires ${minimum} access.`, "FORBIDDEN");
  }
  if (project.error) databaseFailure("Unable to authorize the action project.", project.error);
  if (!project.data) throw new DatabaseContractError("Project was not found in this workspace.", "NOT_FOUND");
}

function classificationDetail(record: ClassificationRecord) {
  const facts = [
    record.mentioned ? "mentioned" : "not mentioned",
    record.cited ? "cited" : "not cited",
    record.explicitly_recommended ? "explicitly recommended" : "not explicitly recommended",
    record.first_choice ? "first choice" : "not first choice",
    record.rejected ? "rejected" : "not rejected",
  ];
  return facts.join(" · ");
}

function referenceMaps(references: ActionReference[]) {
  return new Map(references.map((reference) => [`${reference.kind}:${reference.id}`, reference]));
}

export function parseActionReference(value: string): { kind: ActionReferenceKind; id: string } {
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator) as ActionReferenceKind;
  const id = value.slice(separator + 1);
  if (separator < 1 || !(["question_version", "classification", "source_version"] as const).includes(kind) || !id) {
    throw new DatabaseContractError("Select a valid immutable evidence record.", "CONFLICT");
  }
  return { kind, id };
}

export async function listActionLineageWorkspace(ctx: DbContext, projectId: string): Promise<{
  actions: ActionWithLineage[];
  references: ActionReference[];
  followUpRuns: FollowUpRun[];
}> {
  await authorizeProject(ctx, projectId);
  const client = ctx.client as unknown as LineageClient;
  const scope = (table: string, columns: string, orderColumn: string) => client.from(table).select(columns)
    .eq("workspace_id", ctx.actor.workspaceId).eq("project_id", projectId)
    .order(orderColumn, { ascending: false });
  const [actionsResult, linksResult, followUpsResult, questionsResult, classificationsResult,
    brandsResult, versionsResult, sourcesResult, runsResult] = await Promise.all([
    scope("actions", "*", "updated_at"),
    scope("action_links", "id,action_id,question_version_id,classification_id,source_version_id,rationale,created_at", "created_at"),
    scope("action_run_links", "id,action_id,run_id,outcome_note,causation_asserted,created_at", "created_at"),
    scope("question_versions", "id,version,prompt,locale,created_at", "created_at"),
    scope("brand_classifications", "id,brand_version_id,mentioned,cited,explicitly_recommended,first_choice,rejected,rationale,created_at", "created_at"),
    scope("brand_versions", "id,name,version,created_at", "created_at"),
    scope("source_versions", "id,source_id,version,valid_from,created_at", "created_at"),
    scope("sources", "id,name,created_at", "created_at"),
    scope("runs", "id,status,created_at,completed_at", "created_at"),
  ]);

  const actions = rows<ActionRow>(actionsResult, "Unable to list actions.");
  const links = rows<EvidenceLinkRecord>(linksResult, "Unable to load action evidence lineage.");
  const followUps = rows<FollowUpRecord>(followUpsResult, "Unable to load action follow-up lineage.");
  const questionVersions = rows<QuestionVersionRecord>(questionsResult, "Unable to load question versions for actions.");
  const classifications = rows<ClassificationRecord>(classificationsResult, "Unable to load classifications for actions.");
  const brandVersions = rows<BrandVersionRecord>(brandsResult, "Unable to load classified brands for actions.");
  const sourceVersions = rows<SourceVersionRecord>(versionsResult, "Unable to load source versions for actions.");
  const sources = rows<SourceRecord>(sourcesResult, "Unable to load evidence sources for actions.");
  const runs = rows<RunRecord>(runsResult, "Unable to load follow-up runs for actions.");

  const brandNames = new Map(brandVersions.map((brand) => [brand.id, `${brand.name} v${brand.version}`]));
  const sourceNames = new Map(sources.map((source) => [source.id, source.name]));
  const references: ActionReference[] = [
    ...questionVersions.map((record): ActionReference => ({
      value: `question_version:${record.id}`, kind: "question_version", id: record.id,
      label: `Question v${record.version}: ${record.prompt}`,
      detail: `Immutable ${record.locale} question version`, createdAt: record.created_at,
    })),
    ...classifications.map((record): ActionReference => ({
      value: `classification:${record.id}`, kind: "classification", id: record.id,
      label: `Classification: ${brandNames.get(record.brand_version_id) ?? record.brand_version_id}`,
      detail: `${classificationDetail(record)} · ${record.rationale}`,
      createdAt: record.created_at,
    })),
    ...sourceVersions.map((record): ActionReference => ({
      value: `source_version:${record.id}`, kind: "source_version", id: record.id,
      label: `Source: ${sourceNames.get(record.source_id) ?? record.source_id} v${record.version}`,
      detail: `Immutable version valid from ${new Date(record.valid_from).toLocaleString()}`,
      createdAt: record.created_at,
    })),
  ];
  const referenceByKey = referenceMaps(references);
  const runById = new Map(runs.map((run) => [run.id, run]));

  return {
    references,
    followUpRuns: runs.flatMap((run): FollowUpRun[] => (
      (run.status === "succeeded" || run.status === "partial") && run.completed_at
        ? [{ id: run.id, status: run.status, createdAt: run.created_at, completedAt: run.completed_at }]
        : []
    )),
    actions: actions.map((action) => ({
      ...action,
      evidenceLinks: links.filter((link) => link.action_id === action.id).map((link): ActionEvidenceLink => {
        const target = link.question_version_id
          ? { kind: "question_version" as const, id: link.question_version_id }
          : link.classification_id
            ? { kind: "classification" as const, id: link.classification_id }
            : { kind: "source_version" as const, id: link.source_version_id as string };
        const reference = referenceByKey.get(`${target.kind}:${target.id}`);
        return {
          id: link.id, kind: target.kind, recordId: target.id,
          label: reference?.label ?? `Unavailable ${target.kind.replaceAll("_", " ")} record`,
          detail: reference?.detail ?? "The immutable record is unavailable to this reader.",
          rationale: link.rationale, createdAt: link.created_at,
        };
      }),
      followUps: followUps.filter((followUp) => followUp.action_id === action.id).map((followUp): ActionFollowUp => {
        const run = runById.get(followUp.run_id);
        return {
          id: followUp.id, runId: followUp.run_id,
          runStatus: run?.status ?? "unavailable",
          runCreatedAt: run?.created_at ?? followUp.created_at,
          outcomeNote: followUp.outcome_note,
          causationAsserted: false,
          linkedAt: followUp.created_at,
        };
      }),
    })),
  };
}

export async function createActionWithLineage(ctx: DbContext, input: {
  projectId: string;
  title: string;
  description: string;
  expectedImpact: string;
  effort: string;
  uncertainty: string;
  reference: string;
  rationale: string;
}) {
  await authorizeProject(ctx, input.projectId, "analyst");
  const reference = parseActionReference(input.reference);
  if (input.title.trim().length < 3 || input.title.trim().length > 180) {
    throw new DatabaseContractError("Action title must be between 3 and 180 characters.", "CONFLICT");
  }
  if (input.description.trim().length < 10 || input.rationale.trim().length < 10) {
    throw new DatabaseContractError("Describe the deliverable and the factual evidence rationale.", "CONFLICT");
  }
  if ([input.expectedImpact, input.effort, input.uncertainty].some((value) => value.trim().length < 3)) {
    throw new DatabaseContractError("Expected impact, effort, and uncertainty are required.", "CONFLICT");
  }
  const client = ctx.client as unknown as LineageClient;
  const { data, error } = await client.rpc("create_action_with_lineage", {
    p_workspace_id: ctx.actor.workspaceId,
    p_project_id: input.projectId,
    p_actor_id: ctx.actor.userId,
    p_title: input.title.trim(),
    p_description: input.description.trim(),
    p_expected_impact: input.expectedImpact.trim(),
    p_effort: input.effort.trim(),
    p_uncertainty: input.uncertainty.trim(),
    p_question_version_id: reference.kind === "question_version" ? reference.id : null,
    p_classification_id: reference.kind === "classification" ? reference.id : null,
    p_source_version_id: reference.kind === "source_version" ? reference.id : null,
    p_rationale: input.rationale.trim(),
  });
  if (error) databaseFailure("Unable to create the evidence-linked action.", error);
  if (typeof data !== "string") databaseFailure("The action RPC returned no identifier.", null);
  return data;
}

export async function transitionActionWithFollowUp(ctx: DbContext, input: {
  projectId: string;
  actionId: string;
  status: ActionStatus;
  followUpRunId?: string;
  outcomeNote?: string;
}) {
  await authorizeProject(ctx, input.projectId, "analyst");
  if (!(["proposed", "approved", "in_progress", "completed", "dismissed"] as const).includes(input.status)) {
    throw new DatabaseContractError("Select a valid action status.", "CONFLICT");
  }
  if (input.status === "completed" && (!input.followUpRunId || (input.outcomeNote?.trim().length ?? 0) < 10)) {
    throw new DatabaseContractError("Completion requires a later run and a factual outcome note.", "CONFLICT");
  }
  const client = ctx.client as unknown as LineageClient;
  const { data, error } = await client.rpc("transition_action_with_follow_up", {
    p_workspace_id: ctx.actor.workspaceId,
    p_project_id: input.projectId,
    p_actor_id: ctx.actor.userId,
    p_action_id: input.actionId,
    p_status: input.status,
    p_follow_up_run_id: input.status === "completed" ? input.followUpRunId ?? null : null,
    p_outcome_note: input.status === "completed" ? input.outcomeNote?.trim() ?? null : null,
  });
  if (error) databaseFailure("Unable to update the evidence-linked action.", error);
  if (typeof data !== "string") databaseFailure("The action transition RPC returned no identifier.", null);
  return data;
}
