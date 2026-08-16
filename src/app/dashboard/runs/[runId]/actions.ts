"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRun } from "@/lib/db";
import { cancelMonitoringRun } from "@/lib/platform/run-cancellation";
import { createAdminClient } from "@/lib/supabase/server";
import { canWrite, getDashboardContext } from "../../_context";

function value(formData: FormData, key: string) {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
}

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 240) : "The cancellation could not be completed.";
}

export async function cancelRunAction(formData: FormData) {
  const runId = value(formData, "runId");
  const destination = runId ? `/dashboard/runs/${encodeURIComponent(runId)}` : "/dashboard/runs";
  let saved: string;
  try {
    const ctx = await getDashboardContext();
    if (!canWrite(ctx.actor.role)) throw new Error("Your current workspace role cannot cancel runs.");
    const reason = value(formData, "reason");
    if (reason.length < 3 || reason.length > 500) throw new Error("Give a cancellation reason between 3 and 500 characters.");
    await getRun(ctx, runId);
    const result = await cancelMonitoringRun(createAdminClient(), {
      workspaceId: ctx.actor.workspaceId,
      runId,
      actorId: ctx.actor.userId,
      reason,
    });
    revalidatePath(destination);
    revalidatePath("/dashboard/runs");
    saved = result.replayed ? "This run was already cancelled." : "Run cancelled.";
  } catch (error) {
    redirect(`${destination}?error=${encodeURIComponent(safeMessage(error))}`);
  }
  redirect(`${destination}?saved=${encodeURIComponent(saved)}`);
}
