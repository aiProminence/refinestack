import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createBootstrapInvitation, createInvitation } from "@/lib/db";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import type { WorkspaceActor } from "@/lib/db";
import { claimsHaveFreshMailboxOtp, freshMailboxOtpTime } from "./verification";

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const roleSchema = z.enum(["owner", "admin", "analyst", "viewer"]);

type InvitationRpcError = { code?: string; message?: string };
type InvitationRpcResult<T> = Promise<{ data: T | null; error: InvitationRpcError | null }>;
type InvitationRpcClient = {
  rpc: <T>(name: string, args: Record<string, unknown>) => InvitationRpcResult<T>;
};
type OtpAdmission = { attempt_id: string; email: string; should_create_user: boolean };

export class InvitationVerificationRateLimitError extends Error {
  constructor() {
    super("A mailbox verification is already active. Use the email already sent or wait before retrying.");
    this.name = "InvitationVerificationRateLimitError";
  }
}

class InvitationNoticeDeliveryError extends Error {
  constructor(readonly failureCode: string) {
    super("The invitation notification could not be delivered.");
    this.name = "InvitationNoticeDeliveryError";
  }
}

function appUrl() {
  return new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://refinestack.com");
}

async function findAuthUserIdByEmail(email: string) {
  const admin = createAdminClient();
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("Unable to verify whether the invited account already exists.");
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) return user.id;
    if (data.users.length < 1000) return null;
  }
  throw new Error("The account directory is too large for invitation lookup.");
}

function invitationRpcClient(client: ReturnType<typeof createAdminClient>) {
  return client as unknown as InvitationRpcClient;
}

function safeProviderFailureCode(prefix: string, error: unknown) {
  const candidate = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const suffix = candidate.toLowerCase().replace(/[^a-z0-9_:-]/gu, "_").slice(0, 48);
  return suffix ? `${prefix}_${suffix}` : `${prefix}_unknown`;
}

async function recordInvitationNotificationDelivery(input: {
  invitationId: string;
  succeeded: boolean;
  failureCode?: string;
  actorId?: string;
}) {
  const admin = createAdminClient();
  const { error } = await invitationRpcClient(admin).rpc("record_invitation_notification_delivery", {
    p_invitation_id: input.invitationId,
    p_succeeded: input.succeeded,
    p_failure_code: input.failureCode ?? null,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error("Invitation delivery state could not be recorded.");
}

async function emergencyRevokeInvitation(invitationId: string) {
  const admin = createAdminClient();
  const { error } = await admin.from("workspace_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", invitationId)
    .is("accepted_at", null)
    .is("revoked_at", null);
  if (error) throw new Error("The undelivered invitation could not be revoked.");
}

async function sendInvitationNotice(email: string, invitationId: string, signupProof: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.INVITATION_FROM_EMAIL;
  if (!apiKey || !from) throw new InvitationNoticeDeliveryError("resend_not_configured");
  const destination = new URL("/accept-invite", appUrl());
  destination.searchParams.set("invitation", invitationId);
  destination.searchParams.set("claim", signupProof);
  const invitationUrl = destination.toString();
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from, to: [email], subject: "Your RefineStack invitation",
        text: `You have been invited to RefineStack. Open this non-sign-in invitation, then verify your mailbox: ${invitationUrl}`,
        html: `<p>You have been invited to RefineStack.</p><p><a href="${invitationUrl.replaceAll("&", "&amp;")}">Open the invitation</a>, then verify your mailbox.</p>`,
      }),
    });
  } catch {
    throw new InvitationNoticeDeliveryError("resend_transport");
  }
  if (!response.ok) throw new InvitationNoticeDeliveryError(`resend_http_${response.status}`);
}

async function sendMailboxVerificationLink(email: string, actionLink: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.INVITATION_FROM_EMAIL;
  if (!apiKey || !from) throw new InvitationNoticeDeliveryError("resend_not_configured");
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        subject: "Verify your RefineStack mailbox",
        text: `Open this one-time link to verify your mailbox and continue your RefineStack invitation: ${actionLink}`,
        html: `<p>Verify your mailbox to continue your RefineStack invitation.</p><p><a href="${actionLink.replaceAll("&", "&amp;")}">Verify mailbox</a></p><p>This link expires after use.</p>`,
      }),
    });
  } catch {
    throw new InvitationNoticeDeliveryError("resend_transport");
  }
  if (!response.ok) throw new InvitationNoticeDeliveryError(`resend_http_${response.status}`);
}

async function generateAndSendMailboxVerification(input: {
  admin: ReturnType<typeof createAdminClient>;
  email: string;
  callback: URL;
  invitationId?: string;
  invitationProof?: string;
}) {
  const metadata = input.invitationId && input.invitationProof
    ? { invitation_id: input.invitationId, invitation_proof: input.invitationProof }
    : undefined;
  const { data, error } = await input.admin.auth.admin.generateLink({
    type: "magiclink",
    email: input.email,
    options: {
      redirectTo: input.callback.toString(),
      ...(metadata ? { data: metadata } : {}),
    },
  });
  if (error || !data?.properties?.hashed_token) {
    throw new InvitationNoticeDeliveryError(safeProviderFailureCode("supabase_auth", error));
  }
  const confirmation = new URL("/auth/confirm", appUrl());
  confirmation.searchParams.set("token_hash", data.properties.hashed_token);
  confirmation.searchParams.set("next", input.callback.searchParams.get("next") ?? "/dashboard");
  await sendMailboxVerificationLink(input.email, confirmation.toString());
}

async function deliverInvitationNotice(input: {
  email: string;
  invitationId: string;
  signupProof: string;
  actorId?: string;
}) {
  try {
    await sendInvitationNotice(input.email, input.invitationId, input.signupProof);
  } catch (error) {
    const failureCode = error instanceof InvitationNoticeDeliveryError
      ? error.failureCode
      : safeProviderFailureCode("resend", error);
    try {
      await recordInvitationNotificationDelivery({
        invitationId: input.invitationId,
        succeeded: false,
        failureCode,
        actorId: input.actorId,
      });
    } catch {
      await emergencyRevokeInvitation(input.invitationId);
    }
    throw new Error("Invitation delivery failed and the invitation was revoked. Retry to issue a new invitation.");
  }
  // Delivery has already been accepted by the provider. A transient database
  // recorder failure must not invalidate the link the recipient now owns; the
  // admission RPC also accepts the explicit pending state for this case.
  try {
    await recordInvitationNotificationDelivery({
      invitationId: input.invitationId,
      succeeded: true,
      actorId: input.actorId,
    });
  } catch {
    // The pending row and later OTP-admission event preserve a recoverable,
    // auditable trail without encouraging a duplicate send.
  }
}

export async function inviteWorkspaceMember(input: {
  actor: WorkspaceActor;
  email: string;
  role: "owner" | "admin" | "analyst" | "viewer";
  expiresInHours?: number;
}) {
  const email = emailSchema.parse(input.email);
  const role = roleSchema.parse(input.role);
  const userClient = await createClient();
  const { data: membership, error: membershipError } = await userClient.from("workspace_members")
    .select("role").eq("workspace_id", input.actor.workspaceId).eq("user_id", input.actor.userId).maybeSingle();
  if (membershipError || !membership || membership.role !== input.actor.role) {
    throw new Error("Current workspace authorization could not be verified.");
  }
  const expiresAt = new Date(Date.now() + Math.min(Math.max(input.expiresInHours ?? 72, 1), 168) * 3_600_000).toISOString();
  const signupProof = randomBytes(32).toString("base64url");
  const signupProofHash = createHash("sha256").update(signupProof).digest("hex");
  const admin = createAdminClient();
  const invitation = await createInvitation({ client: admin, actor: input.actor }, { email, role, expiresAt, signupProofHash });
  await deliverInvitationNotice({ email, invitationId: invitation.id, signupProof, actorId: input.actor.userId });
  return invitation;
}

export async function createOwnerBootstrap(input: { email: string; expiresInHours?: number }) {
  const email = emailSchema.parse(input.email);
  const expiresAt = new Date(Date.now() + Math.min(Math.max(input.expiresInHours ?? 24, 1), 72) * 3_600_000).toISOString();
  const signupProof = randomBytes(32).toString("base64url");
  const signupProofHash = createHash("sha256").update(signupProof).digest("hex");
  const admin = createAdminClient();
  const invitation = await createBootstrapInvitation({ client: admin, email, expiresAt, signupProofHash });
  await deliverInvitationNotice({ email, invitationId: invitation.id, signupProof });
  return invitation;
}

export async function getPendingInvitationForCurrentUser(invitationId?: string) {
  const client = await createClient();
  const { data: authData, error: authError } = await client.auth.getUser();
  if (authError || !authData.user) return null;
  let query = client.from("workspace_invitations")
    .select("id,workspace_id,invitation_kind,email,role,expires_at,email_reverification_requested_at")
    .eq("invited_user_id", authData.user.id)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true });
  if (invitationId) query = query.eq("id", invitationId);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error("Unable to verify the pending invitation.");
  return data;
}

export async function hasFreshMailboxVerification(requestedAt: string | null) {
  const client = await createClient();
  const { data, error } = await client.auth.getClaims();
  return !error && claimsHaveFreshMailboxOtp(data?.claims, requestedAt);
}

export async function getFreshMailboxVerifiedAt(requestedAt: string | null) {
  const client = await createClient();
  const { data, error } = await client.auth.getClaims();
  return error ? null : freshMailboxOtpTime(data?.claims, requestedAt);
}

export async function getOpenInvitationByClaim(invitationId: string, claim: string) {
  if (!/^[A-Za-z0-9_-]{40,100}$/u.test(claim)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin.from("workspace_invitations")
    .select("*")
    .eq("id", invitationId).is("accepted_at", null).is("revoked_at", null)
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error || !data) return null;
  const hardened = data as typeof data & { signup_proof_consumed_at?: string | null };
  if (hardened.signup_proof_consumed_at) return null;
  const actual = Buffer.from(createHash("sha256").update(claim).digest("hex"));
  const expected = Buffer.from(data.signup_proof_hash);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? data : null;
}

export async function requestInvitationMailboxOtp(invitationId: string, claim: string) {
  const invitation = await getOpenInvitationByClaim(invitationId, claim);
  if (!invitation) throw new Error("The invitation is invalid or expired.");
  const admin = createAdminClient();
  const existingUserId = await findAuthUserIdByEmail(invitation.email);
  const proofHash = createHash("sha256").update(claim).digest("hex");
  const { data: admission, error: admissionError } = await invitationRpcClient(admin).rpc<OtpAdmission>(
    "admit_invitation_mailbox_otp",
    {
      p_invitation_id: invitation.id,
      p_signup_proof_hash: proofHash,
      p_authenticated_user_id: null,
      p_existing_user_id: existingUserId,
    },
  );
  if (admissionError?.code === "55P03") throw new InvitationVerificationRateLimitError();
  if (admissionError || !admission) throw new Error("Mailbox verification could not be started.");
  const destination = new URL("/accept-invite", appUrl());
  destination.searchParams.set("invitation", invitation.id);
  const callback = new URL("/auth/callback", appUrl());
  callback.searchParams.set("next", `${destination.pathname}${destination.search}`);
  try {
    await generateAndSendMailboxVerification({
      admin,
      email: admission.email,
      callback,
      invitationId: admission.should_create_user ? invitation.id : undefined,
      invitationProof: admission.should_create_user ? claim : undefined,
    });
  } catch (error) {
    await invitationRpcClient(admin).rpc("finalize_invitation_mailbox_otp", {
      p_invitation_id: invitation.id,
      p_attempt_id: admission.attempt_id,
      p_succeeded: false,
      p_failure_code: error instanceof InvitationNoticeDeliveryError
        ? error.failureCode
        : safeProviderFailureCode("mailbox_delivery", error),
    });
    throw new Error("The mailbox verification link could not be sent.");
  }
  const { error: finalizeError } = await invitationRpcClient(admin).rpc("finalize_invitation_mailbox_otp", {
    p_invitation_id: invitation.id,
    p_attempt_id: admission.attempt_id,
    p_succeeded: true,
    p_failure_code: null,
  });
  if (finalizeError) throw new Error("Mailbox verification was sent but its state could not be finalized.");
}

export async function requestFreshMailboxVerification(invitationId: string) {
  const client = await createClient();
  const invitation = await getPendingInvitationForCurrentUser(invitationId);
  if (!invitation || invitation.id !== invitationId) throw new Error("The invitation is invalid or expired.");
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) throw new Error("The invitation account could not be verified.");
  const admin = createAdminClient();
  const { data: admission, error: admissionError } = await invitationRpcClient(admin).rpc<OtpAdmission>(
    "admit_invitation_mailbox_otp",
    {
      p_invitation_id: invitation.id,
      p_signup_proof_hash: null,
      p_authenticated_user_id: userData.user.id,
      p_existing_user_id: null,
    },
  );
  if (admissionError?.code === "55P03") throw new InvitationVerificationRateLimitError();
  if (admissionError || !admission) throw new Error("Mailbox verification could not be started.");
  const destination = new URL("/accept-invite", appUrl());
  destination.searchParams.set("invitation", invitation.id);
  const callback = new URL("/auth/callback", appUrl());
  callback.searchParams.set("next", `${destination.pathname}${destination.search}`);
  try {
    await generateAndSendMailboxVerification({ admin, email: admission.email, callback });
  } catch (error) {
    await invitationRpcClient(admin).rpc("finalize_invitation_mailbox_otp", {
      p_invitation_id: invitation.id,
      p_attempt_id: admission.attempt_id,
      p_succeeded: false,
      p_failure_code: error instanceof InvitationNoticeDeliveryError
        ? error.failureCode
        : safeProviderFailureCode("mailbox_delivery", error),
    });
    throw new Error("The fresh mailbox link could not be sent.");
  }
  const { error: finalizeError } = await invitationRpcClient(admin).rpc("finalize_invitation_mailbox_otp", {
    p_invitation_id: invitation.id,
    p_attempt_id: admission.attempt_id,
    p_succeeded: true,
    p_failure_code: null,
  });
  if (finalizeError) throw new Error("Mailbox verification was sent but its state could not be finalized.");
  await client.auth.signOut({ scope: "local" });
}
