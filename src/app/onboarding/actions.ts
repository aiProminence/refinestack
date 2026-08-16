"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { bootstrapWorkspace } from "@/lib/db";
import { getFreshMailboxVerifiedAt, getPendingInvitationForCurrentUser } from "@/lib/auth/invitations";
import { createAdminClient, getUser, getWorkspace } from "@/lib/supabase/server";
import { syncProviderHealth } from "@/lib/worker/maintenance";

function onboardingError(message: string) {
  return `/onboarding?error=${encodeURIComponent(message)}`;
}

export async function createFirstWorkspace(formData: FormData) {
  const user = await getUser();
  if (!user) redirect("/login?next=/onboarding");
  if (await getWorkspace()) redirect("/dashboard");
  const invitation = await getPendingInvitationForCurrentUser();
  if (!invitation) redirect("/access-revoked");
  if (invitation.invitation_kind === "workspace") {
    redirect(`/accept-invite?invitation=${encodeURIComponent(invitation.id)}`);
  }
  const verifiedAt = await getFreshMailboxVerifiedAt(invitation.email_reverification_requested_at);
  if (!verifiedAt) redirect("/access-revoked");

  const name = String(formData.get("workspaceName") ?? "").trim();
  if (name.length < 2 || name.length > 120) {
    redirect(onboardingError("Use a workspace name between 2 and 120 characters."));
  }

  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 46) || "workspace";
  const slug = `${base}-${randomBytes(4).toString("hex")}`;
  try {
    const admin = createAdminClient();
    await bootstrapWorkspace({ client: admin, invitationId: invitation.id, userId: user.id, name, slug, verifiedAt });
    try { await syncProviderHealth(admin); } catch {
      // The scheduled worker retries provider registration. Workspace creation
      // remains valid even if this non-authoritative health sync is unavailable.
    }
  } catch {
    redirect(onboardingError("The workspace could not be created. Please retry."));
  }
  redirect("/dashboard/setup");
}
