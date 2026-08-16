"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createBrand,
  createProject,
  createQuestion,
  createQuestionSet,
  createSchedule,
  createSource,
  getProject,
  getRunPreflight,
  listQuestions,
  listPendingClassificationReviews,
  removeMember,
  resetScheduleCircuit,
  requestRun,
  revokeInvitation,
  updateBrand,
  updateMemberRole,
  updateProject,
  updateQuestion,
  updateSchedule,
  submitClassificationReview,
} from "@/lib/db";
import { validateQuestionDraft, type QuestionDraft } from "@/lib/ai/questions";
import type { WorkspaceRole } from "@/types/contracts";
import { inviteWorkspaceMember } from "@/lib/auth/invitations";
import { createAdminClient } from "@/lib/supabase/server";
import { retrieveEvidenceUrl } from "@/lib/evidence/ingest";
import { diagnoseProjectDomain } from "@/lib/security/domain-diagnostics";
import { getDashboardContext } from "./_context";

function required(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function optional(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function questionDraft(formData: FormData): QuestionDraft {
  return {
    prompt: optional(formData, "prompt") ?? "",
    questionType: optional(formData, "questionType") ?? "",
    persona: optional(formData, "persona") ?? "",
    stage: optional(formData, "stage") ?? "",
    market: optional(formData, "market") ?? "",
    locale: optional(formData, "locale") ?? "",
    rationale: optional(formData, "rationale") ?? "",
  };
}

function checkedQuestionDraft(draft: QuestionDraft, knownQuestions: Array<{ id: string; current_prompt: string }>) {
  const result = validateQuestionDraft(draft, {
    knownQuestions: knownQuestions.map(({ id, current_prompt }) => ({ id, prompt: current_prompt })),
  });
  if (result.issues.length) {
    const duplicate = result.nearestDuplicate
      ? ` Closest existing question is ${Math.round(result.nearestDuplicate.similarity * 100)}% similar: “${result.nearestDuplicate.prompt.slice(0, 100)}”.`
      : "";
    throw new Error(`${result.issues.map(({ message }) => message).join(" ")}${duplicate}`);
  }
  return result.value;
}

function message(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 240) : "The request could not be completed.";
}

function destination(path: string, kind: "saved" | "error", value: string) {
  return `${path}?${kind}=${encodeURIComponent(value)}`;
}

export async function saveProjectAction(formData: FormData) {
  const ctx = await getDashboardContext();
  let savedMessage = "Project saved.";
  try {
    const id = optional(formData, "projectId");
    const name = required(formData, "projectName");
    const domain = optional(formData, "domain");
    const category = optional(formData, "category");
    const market = required(formData, "market");
    const locale = required(formData, "locale");
    const languages = required(formData, "languages").split(",").map((item) => item.trim()).filter(Boolean);
    let verifiedDomain = domain;
    if (domain) {
      const diagnostic = await diagnoseProjectDomain(domain);
      verifiedDomain = diagnostic.canonicalUrl;
      if (diagnostic.sparse) savedMessage = "Project saved. The primary domain returned sparse readable content; add explicit evidence before relying on it.";
    }
    if (!languages.length) throw new Error("At least one language is required.");
    if (id) {
      await updateProject(ctx, id, {
        name,
        domain: verifiedDomain ?? null,
        category: category ?? null,
        default_market: market,
        default_locale: locale,
        languages,
      });
    } else {
      await createProject(ctx, { name, domain: verifiedDomain, category, market, locale, languages });
    }
    revalidatePath("/dashboard", "layout");
  } catch (error) {
    redirect(destination("/dashboard/setup", "error", message(error)));
  }
  redirect(destination("/dashboard/setup", "saved", savedMessage));
}

export async function saveBrandAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try {
    const id = optional(formData, "brandId");
    const role = required(formData, "role");
    if (role !== "primary" && role !== "competitor") throw new Error("Invalid brand role.");
    const input = {
      name: required(formData, "name"),
      domain: required(formData, "domain"),
      market: required(formData, "market"),
      role,
    } as const;
    new URL(input.domain);
    if (id) await updateBrand(ctx, id, input);
    else await createBrand(ctx, { projectId: required(formData, "projectId"), ...input });
    revalidatePath("/dashboard", "layout");
  } catch (error) {
    redirect(destination("/dashboard/setup", "error", message(error)));
  }
  redirect(destination("/dashboard/setup", "saved", "Brand saved."));
}

export async function createQuestionAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try {
    const projectId = required(formData, "projectId");
    const existing = await listQuestions(ctx, projectId);
    const draft = checkedQuestionDraft(questionDraft(formData), existing);
    await createQuestion(ctx, {
      projectId,
      prompt: draft.prompt,
      market: draft.market,
      locale: draft.locale,
      questionType: draft.questionType,
      persona: draft.persona,
      stage: draft.stage,
      rationale: draft.rationale,
    });
    revalidatePath("/dashboard/questions");
  } catch (error) {
    redirect(destination("/dashboard/questions", "error", message(error)));
  }
  redirect(destination("/dashboard/questions", "saved", "Question added."));
}

export async function updateQuestionStateAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try {
    const id = required(formData, "questionId");
    const projectId = required(formData, "projectId");
    const state = required(formData, "state");
    if (!(["active", "disqualified", "archived"] as const).includes(state as "active" | "disqualified" | "archived")) throw new Error("Invalid question state.");
    if (state === "active") {
      const projectQuestions = await listQuestions(ctx, projectId);
      const question = projectQuestions.find((candidate) => candidate.id === id);
      if (!question) throw new Error("Question was not found in this project.");
      checkedQuestionDraft({
        prompt: question.current_prompt,
        questionType: question.question_type,
        persona: question.persona ?? "",
        stage: question.stage ?? "",
        market: question.market,
        locale: question.locale,
        rationale: question.rationale ?? "",
      }, projectQuestions.filter((candidate) => candidate.id !== id));
    }
    await updateQuestion(ctx, id, {
      state: state as "active" | "disqualified" | "archived",
      disqualification_reason: state === "disqualified" ? required(formData, "reason") : null,
    });
    revalidatePath("/dashboard/questions");
  } catch (error) {
    redirect(destination("/dashboard/questions", "error", message(error)));
  }
  redirect(destination("/dashboard/questions", "saved", "Question state updated."));
}

export async function editQuestionAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try {
    const id = required(formData, "questionId");
    const projectId = required(formData, "projectId");
    const projectQuestions = await listQuestions(ctx, projectId);
    if (!projectQuestions.some((question) => question.id === id)) throw new Error("Question was not found in this project.");
    const draft = checkedQuestionDraft(questionDraft(formData), projectQuestions.filter((question) => question.id !== id));
    await updateQuestion(ctx, id, {
      current_prompt: draft.prompt,
      market: draft.market,
      locale: draft.locale,
      question_type: draft.questionType,
      persona: draft.persona,
      stage: draft.stage,
      rationale: draft.rationale,
    });
    revalidatePath("/dashboard/questions");
  } catch (error) {
    redirect(destination("/dashboard/questions", "error", message(error)));
  }
  redirect(destination("/dashboard/questions", "saved", "Question updated."));
}

export async function createEvidenceAction(formData: FormData) {
  const userCtx = await getDashboardContext();
  try {
    const projectId = required(formData, "projectId");
    await getProject(userCtx, projectId);
    const kind = required(formData, "kind");
    if (kind !== "url" && kind !== "text") throw new Error("Only URL and text evidence are supported here.");
    const url = optional(formData, "url");
    const content = optional(formData, "content");
    if (kind === "url" && !url) throw new Error("url is required.");
    if (kind === "text" && !content) throw new Error("content is required.");
    if (content && content.length > 1_000_000) throw new Error("Evidence text exceeds the 1,000,000-character limit.");
    const retrieved = kind === "url" ? await retrieveEvidenceUrl(url!) : null;
    const textHash = content ? createHash("sha256").update(content).digest("hex") : null;
    await createSource({ client: createAdminClient(), actor: userCtx.actor }, {
      projectId,
      kind,
      name: required(formData, "name"),
      originalUrl: retrieved?.originalUrl,
      canonicalUrl: retrieved?.canonicalUrl,
      contentText: retrieved?.contentText ?? content,
      contentHash: retrieved?.contentHash ?? textHash!,
      mimeType: retrieved?.mimeType ?? "text/plain",
      retrievedAt: retrieved?.retrievedAt,
      retrievalMetadata: retrieved?.retrievalMetadata,
      policy: {
        retrievalAllowed: formData.get("retrievalAllowed") === "on",
        quotingAllowed: formData.get("quotingAllowed") === "on",
        exportAllowed: formData.get("exportAllowed") === "on",
      },
    });
    revalidatePath("/dashboard/evidence");
  } catch (error) {
    redirect(destination("/dashboard/evidence", "error", message(error)));
  }
  redirect(destination("/dashboard/evidence", "saved", "Evidence source added."));
}

export async function updateScheduleAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try {
    await updateSchedule(ctx, required(formData, "scheduleId"), {
      enabled: required(formData, "enabled") === "true",
    });
    revalidatePath("/dashboard/operations");
  } catch (error) {
    redirect(destination("/dashboard/operations", "error", message(error)));
  }
  redirect(destination("/dashboard/operations", "saved", "Schedule updated."));
}

export async function resetScheduleCircuitAction(formData: FormData) {
  const userCtx = await getDashboardContext();
  try {
    const projectId = required(formData, "projectId");
    await resetScheduleCircuit(
      { client: createAdminClient(), actor: userCtx.actor },
      projectId,
      required(formData, "scheduleId"),
    );
    revalidatePath("/dashboard/operations");
  } catch (error) {
    redirect(destination("/dashboard/operations", "error", message(error)));
  }
  redirect(destination("/dashboard/operations", "saved", "Schedule circuit reset."));
}

export async function createScheduleAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try {
    const projectId = required(formData, "projectId");
    const preflight = await getRunPreflight(ctx, projectId);
    if (!preflight.activeQuestionSetId) throw new Error("Save the active question cohort as a question set before scheduling.");
    const healthyProviders = preflight.providers.filter((provider) => provider.enabled && provider.state === "healthy").map((provider) => provider.provider);
    if (!healthyProviders.length) throw new Error("Run a manual capture successfully before scheduling this provider.");
    const frequency = required(formData, "frequency");
    if (frequency !== "daily" && frequency !== "weekly" && frequency !== "monthly") throw new Error("Invalid frequency.");
    const overlapPolicy = required(formData, "overlapPolicy");
    if (overlapPolicy !== "skip" && overlapPolicy !== "queue") throw new Error("Invalid overlap policy.");
    const timezone = required(formData, "timezone");
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
    } catch {
      throw new Error("Timezone must be a recognized IANA timezone, such as Asia/Kuala_Lumpur.");
    }
    const nextRunValue = required(formData, "nextRunAt");
    const nextRunAt = new Date(`${nextRunValue}Z`);
    if (Number.isNaN(nextRunAt.valueOf()) || nextRunAt <= new Date()) throw new Error("Next run must be a valid future date and time.");
    await createSchedule(ctx, {
      projectId,
      questionSetId: preflight.activeQuestionSetId,
      providers: healthyProviders,
      name: required(formData, "name"),
      frequency,
      timezone,
      localTime: required(formData, "localTime"),
      overlapPolicy,
      nextRunAt: nextRunAt.toISOString(),
    });
    revalidatePath("/dashboard/operations");
  } catch (error) {
    redirect(destination("/dashboard/operations", "error", message(error)));
  }
  redirect(destination("/dashboard/operations", "saved", "Schedule created."));
}

export async function saveActiveCohortAction(formData: FormData) {
  const userCtx = await getDashboardContext();
  try {
    const projectId = required(formData, "projectId");
    const preflight = await getRunPreflight(userCtx, projectId);
    if (!preflight.activeQuestionVersionIds.length) throw new Error("There are no active question versions to save.");
    if (preflight.activeQuestionSetId) throw new Error("The active cohort already has an exact immutable question set.");
    await createQuestionSet({ client: createAdminClient(), actor: userCtx.actor }, {
      projectId,
      name: required(formData, "name"),
      questionVersionIds: preflight.activeQuestionVersionIds,
    });
    revalidatePath("/dashboard/operations");
    revalidatePath("/dashboard/runs/new");
  } catch (error) {
    redirect(destination("/dashboard/operations", "error", message(error)));
  }
  redirect(destination("/dashboard/operations", "saved", "Active question cohort saved."));
}

export async function requestRunAction(formData: FormData) {
  const userCtx = await getDashboardContext();
  const projectId = required(formData, "projectId");
  let runId: string;
  try {
    const preflight = await getRunPreflight(userCtx, projectId);
    if (!preflight.quota.ready) throw new Error(`Preflight is blocked: ${preflight.quota.reason?.replaceAll("_", " ") ?? "unknown reason"}.`);
    const result = await requestRun({ client: createAdminClient(), actor: userCtx.actor }, {
      projectId,
      questionVersionIds: preflight.activeQuestionVersionIds,
      providers: preflight.selectedProviderKeys,
      idempotencyKey: required(formData, "idempotencyKey"),
    });
    runId = String(result);
    revalidatePath("/dashboard", "layout");
  } catch (error) {
    redirect(destination("/dashboard/runs/new", "error", message(error)));
  }
  redirect(`/dashboard/runs/${encodeURIComponent(runId)}`);
}

export async function submitReviewAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try {
    const projectId = required(formData, "projectId");
    const classificationId = required(formData, "classificationId");
    const pending = await listPendingClassificationReviews(ctx, projectId);
    const review = pending.find((item) => item.classificationId === classificationId);
    if (!review) throw new Error("This classification is no longer pending review.");
    const decision = required(formData, "decision");
    if (decision !== "approved" && decision !== "overridden") throw new Error("Invalid review decision.");
    const rankText = optional(formData, "rank");
    if (rankText && (!Number.isInteger(Number(rankText)) || Number(rankText) < 1)) throw new Error("Rank must be a positive whole number.");
    const afterValue = decision === "approved" ? review.beforeValue : {
      mentioned: formData.get("mentioned") === "on",
      cited: formData.get("cited") === "on",
      shortlisted: formData.get("shortlisted") === "on",
      explicitlyRecommended: formData.get("explicitlyRecommended") === "on",
      firstChoice: formData.get("firstChoice") === "on",
      rejected: formData.get("rejected") === "on",
      rank: rankText ? Number(rankText) : null,
    };
    await submitClassificationReview({ ...ctx, client: createAdminClient() }, {
      projectId,
      classificationId,
      decision,
      reason: required(formData, "reason"),
      afterValue,
    });
    revalidatePath("/dashboard/questions/review");
  } catch (error) {
    redirect(destination("/dashboard/questions/review", "error", message(error)));
  }
  redirect(destination("/dashboard/questions/review", "saved", "Review submitted."));
}

export async function updateMemberRoleAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try {
    const role = required(formData, "role") as WorkspaceRole;
    if (!(["owner", "admin", "analyst", "viewer"] as const).includes(role)) throw new Error("Invalid workspace role.");
    await updateMemberRole(ctx, required(formData, "userId"), role);
    revalidatePath("/dashboard/team");
  } catch (error) {
    redirect(destination("/dashboard/team", "error", message(error)));
  }
  redirect(destination("/dashboard/team", "saved", "Member role updated."));
}

export async function inviteMemberAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try {
    const role = required(formData, "role") as WorkspaceRole;
    if (!(["owner", "admin", "analyst", "viewer"] as const).includes(role)) throw new Error("Invalid workspace role.");
    await inviteWorkspaceMember({ actor: ctx.actor, email: required(formData, "email"), role });
    revalidatePath("/dashboard/team");
  } catch (error) {
    redirect(destination("/dashboard/team", "error", message(error)));
  }
  redirect(destination("/dashboard/team", "saved", "Invitation email sent."));
}

export async function removeMemberAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try {
    await removeMember(ctx, required(formData, "userId"));
    revalidatePath("/dashboard/team");
  } catch (error) {
    redirect(destination("/dashboard/team", "error", message(error)));
  }
  redirect(destination("/dashboard/team", "saved", "Member removed."));
}

export async function revokeInvitationAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try {
    await revokeInvitation({ ...ctx, client: createAdminClient() }, required(formData, "invitationId"));
    revalidatePath("/dashboard/team");
  } catch (error) {
    redirect(destination("/dashboard/team", "error", message(error)));
  }
  redirect(destination("/dashboard/team", "saved", "Invitation revoked."));
}
