"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createApiToken, revokeApiToken, type ApiScope } from "@/lib/platform/tokens";
import { disableWebhookEndpoint, registerWebhookEndpoint } from "@/lib/platform/webhooks";
import type { WebhookEventName } from "@/types/contracts";
import { createAdminClient, createClient, signOutSession } from "@/lib/supabase/server";
import { deleteWorkspace, processWorkspaceStorageCleanup, WorkspaceDeletionError } from "@/lib/db/workspace-lifecycle";
import { getDashboardContext } from "../_context";

export type SecretActionState = { ok: boolean; message: string; secret?: string };
export type WorkspaceDeletionActionState = { ok: boolean; message: string };

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 240) : "The integration could not be saved.";
}

export async function createTokenAction(_state: SecretActionState, formData: FormData): Promise<SecretActionState> {
  const ctx = await getDashboardContext();
  try {
    const scopes = ["read", "run", "export"].filter((scope) => formData.get(scope) === "on") as ApiScope[];
    const expiryInput = String(formData.get("expiresAt") ?? "").trim();
    if (expiryInput && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(expiryInput)) {
      throw new Error("Enter a valid UTC expiry date and time.");
    }
    const expiryDate = expiryInput ? new Date(`${expiryInput}:00Z`) : null;
    if (expiryDate && (Number.isNaN(expiryDate.getTime()) || expiryDate <= new Date())) {
      throw new Error("Token expiry must be a valid future UTC date and time.");
    }
    const expiresAt = expiryDate?.toISOString() ?? null;
    const result = await createApiToken({ workspaceId: ctx.actor.workspaceId, actorUserId: ctx.actor.userId, name: String(formData.get("name") ?? ""), scopes, expiresAt, admin: createAdminClient() });
    revalidatePath("/dashboard/settings");
    return { ok: true, message: "Copy this token now. It will not be shown again.", secret: result.token };
  } catch (error) { return { ok: false, message: safeMessage(error) }; }
}

export async function createWebhookAction(_state: SecretActionState, formData: FormData): Promise<SecretActionState> {
  const ctx = await getDashboardContext();
  try {
    const allowed: WebhookEventName[] = ["run.started", "run.completed", "run.partial", "run.failed", "review.required", "action.created", "action.completed"];
    const eventNames = allowed.filter((event) => formData.get(event) === "on");
    const result = await registerWebhookEndpoint({ workspaceId: ctx.actor.workspaceId, actorUserId: ctx.actor.userId, name: String(formData.get("name") ?? ""), endpointUrl: String(formData.get("endpointUrl") ?? ""), eventNames, admin: createAdminClient() as never });
    revalidatePath("/dashboard/settings");
    return { ok: true, message: "Copy this signing secret now. It will not be shown again.", secret: result.secret };
  } catch (error) { return { ok: false, message: safeMessage(error) }; }
}

export async function revokeTokenAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try { await revokeApiToken({ workspaceId: ctx.actor.workspaceId, actorUserId: ctx.actor.userId, tokenId: String(formData.get("tokenId") ?? ""), admin: createAdminClient() }); }
  catch (error) { redirect(`/dashboard/settings?error=${encodeURIComponent(safeMessage(error))}`); }
  revalidatePath("/dashboard/settings"); redirect("/dashboard/settings");
}

export async function disableWebhookAction(formData: FormData) {
  const ctx = await getDashboardContext();
  try { await disableWebhookEndpoint({ workspaceId: ctx.actor.workspaceId, actorUserId: ctx.actor.userId, endpointId: String(formData.get("endpointId") ?? ""), admin: createAdminClient() as never }); }
  catch (error) { redirect(`/dashboard/settings?error=${encodeURIComponent(safeMessage(error))}`); }
  revalidatePath("/dashboard/settings"); redirect("/dashboard/settings");
}

export async function deleteWorkspaceAction(
  _state: WorkspaceDeletionActionState,
  formData: FormData,
): Promise<WorkspaceDeletionActionState> {
  const ctx = await getDashboardContext();
  if (ctx.actor.role !== "owner") {
    return { ok: false, message: "Only a current workspace owner can delete this workspace." };
  }

  const confirmation = String(formData.get("confirmation") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!confirmation || !password) {
    return { ok: false, message: "Enter the exact workspace slug and your current password." };
  }

  const client = await createClient();
  const { data: currentUser, error: userError } = await client.auth.getUser();
  const email = currentUser.user?.email;
  if (userError || !email || currentUser.user.id !== ctx.actor.userId) {
    return { ok: false, message: "Your session could not be verified. Sign in again before deleting this workspace." };
  }

  const { data: reauthenticated, error: passwordError } = await client.auth.signInWithPassword({ email, password });
  if (passwordError || reauthenticated.user.id !== ctx.actor.userId) {
    return { ok: false, message: "The current password is incorrect." };
  }

  const admin = createAdminClient();
  let storageCleanupId: string;
  try {
    const deletion = await deleteWorkspace(admin, {
      workspaceId: ctx.actor.workspaceId,
      actorId: ctx.actor.userId,
      confirmation,
      reauthenticationMethod: "password",
      reauthenticatedAt: new Date().toISOString(),
    });
    storageCleanupId = deletion.storage_cleanup_id;
  } catch (error) {
    if (error instanceof WorkspaceDeletionError) return { ok: false, message: error.message };
    return { ok: false, message: "Workspace deletion is temporarily unavailable." };
  }

  try {
    await processWorkspaceStorageCleanup(admin, {
      workerId: `workspace-delete:${randomUUID()}`,
      cleanupId: storageCleanupId,
      limit: 10,
      leaseSeconds: 300,
    });
  } catch {
    // Database deletion already committed. The durable worker queue retains
    // every exact object path and will retry without exposing it to the client.
  }

  await signOutSession();
  redirect("/login?success=Workspace%20deleted.%20Stored%20evidence%20cleanup%20is%20durably%20queued.");
}
