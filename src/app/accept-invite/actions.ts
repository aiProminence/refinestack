"use server";

import { redirect } from "next/navigation";
import { acceptInvitationForCurrentUser } from "@/lib/db";
import {
  getFreshMailboxVerifiedAt,
  getPendingInvitationForCurrentUser,
  InvitationVerificationRateLimitError,
  requestFreshMailboxVerification,
  requestInvitationMailboxOtp,
} from "@/lib/auth/invitations";
import { createAdminClient, createClient } from "@/lib/supabase/server";

export async function completeInvitation(formData: FormData) {
  const fullName = String(formData.get("fullName") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("passwordConfirmation") ?? "");
  const invitationId = String(formData.get("invitationId") ?? "");

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) redirect("/login?error=This%20invitation%20is%20invalid%20or%20has%20expired.");
  const invitation = await getPendingInvitationForCurrentUser(invitationId);
  if (!invitation || invitation.id !== invitationId) {
    redirect("/accept-invite?error=This%20invitation%20is%20invalid%20or%20has%20expired.");
  }
  const verifiedAt = await getFreshMailboxVerifiedAt(invitation.email_reverification_requested_at);
  if (!verifiedAt) {
    redirect(`/accept-invite?invitation=${encodeURIComponent(invitation.id)}&error=Verify%20the%20fresh%20mailbox%20link%20before%20continuing.`);
  }

  const createdForInvitation = userData.user.user_metadata?.invitation_id === invitation.id;
  if (createdForInvitation) {
    if (fullName.length < 2) redirect("/accept-invite?error=Enter%20your%20full%20name.");
    if (password.length < 12) redirect("/accept-invite?error=Use%20at%20least%2012%20characters.");
    if (password !== confirmation) redirect("/accept-invite?error=The%20passwords%20do%20not%20match.");
    const { error: passwordError } = await supabase.auth.updateUser({ password, data: { full_name: fullName } });
    if (passwordError) redirect("/accept-invite?error=This%20invitation%20could%20not%20be%20completed.");
  }

  if (createdForInvitation) {
    const { error: profileError } = await supabase.from("profiles")
      .update({ full_name: fullName, updated_at: new Date().toISOString() }).eq("id", userData.user.id);
    if (profileError) redirect("/accept-invite?error=Your%20profile%20could%20not%20be%20saved.");
  }

  if (invitation.invitation_kind === "bootstrap") redirect("/onboarding");
  try {
    await acceptInvitationForCurrentUser(createAdminClient(), invitation.id, userData.user.id, verifiedAt);
  } catch {
    redirect(`/accept-invite?invitation=${encodeURIComponent(invitation.id)}&error=This%20invitation%20could%20not%20be%20completed.`);
  }
  redirect("/dashboard");
}

export async function sendFreshMailboxVerification(formData: FormData) {
  const invitationId = String(formData.get("invitationId") ?? "");
  try {
    await requestFreshMailboxVerification(invitationId);
  } catch (error) {
    if (error instanceof InvitationVerificationRateLimitError) {
      redirect(`/accept-invite?invitation=${encodeURIComponent(invitationId)}&error=${encodeURIComponent(error.message)}`);
    }
    redirect(`/accept-invite?invitation=${encodeURIComponent(invitationId)}&error=The%20fresh%20mailbox%20link%20could%20not%20be%20sent.`);
  }
  redirect("/login?success=Open%20the%20new%20link%20sent%20to%20your%20mailbox%20to%20finish%20the%20invitation.");
}

export async function sendInvitationMailboxOtp(formData: FormData) {
  const invitationId = String(formData.get("invitationId") ?? "");
  const claim = String(formData.get("claim") ?? "");
  try { await requestInvitationMailboxOtp(invitationId, claim); }
  catch (error) {
    if (error instanceof InvitationVerificationRateLimitError) {
      redirect(`/accept-invite?invitation=${encodeURIComponent(invitationId)}&claim=${encodeURIComponent(claim)}&error=${encodeURIComponent(error.message)}`);
    }
    redirect("/access-revoked");
  }
  redirect("/login?success=Open%20the%20fresh%20link%20sent%20to%20the%20invited%20mailbox.");
}
