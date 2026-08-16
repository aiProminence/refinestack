"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/server";
import { createActionWithLineage, transitionActionWithFollowUp, type ActionStatus } from "@/lib/db/action-lineage";
import { getDashboardContext } from "../_context";

function required(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function optional(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function message(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 240) : "The request could not be completed.";
}

function destination(kind: "saved" | "error", value: string) {
  return `/dashboard/actions?${kind}=${encodeURIComponent(value)}`;
}

export async function createEvidenceLinkedAction(formData: FormData) {
  const userCtx = await getDashboardContext();
  try {
    await createActionWithLineage({ client: createAdminClient(), actor: userCtx.actor }, {
      projectId: required(formData, "projectId"),
      title: required(formData, "title"),
      description: required(formData, "description"),
      expectedImpact: required(formData, "expectedImpact"),
      effort: required(formData, "effort"),
      uncertainty: required(formData, "uncertainty"),
      reference: required(formData, "lineageTarget"),
      rationale: required(formData, "lineageRationale"),
    });
    revalidatePath("/dashboard/actions");
  } catch (error) {
    redirect(destination("error", message(error)));
  }
  redirect(destination("saved", "Evidence-linked action added."));
}

export async function transitionEvidenceLinkedAction(formData: FormData) {
  const userCtx = await getDashboardContext();
  try {
    const status = required(formData, "status") as ActionStatus;
    await transitionActionWithFollowUp({ client: createAdminClient(), actor: userCtx.actor }, {
      projectId: required(formData, "projectId"),
      actionId: required(formData, "actionId"),
      status,
      followUpRunId: optional(formData, "followUpRunId"),
      outcomeNote: optional(formData, "outcomeNote"),
    });
    revalidatePath("/dashboard/actions");
  } catch (error) {
    redirect(destination("error", message(error)));
  }
  redirect(destination("saved", "Action status and outcome lineage updated."));
}
