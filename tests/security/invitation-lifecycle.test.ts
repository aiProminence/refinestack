import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createInvitation: vi.fn(),
  createBootstrapInvitation: vi.fn(),
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createInvitation: mocks.createInvitation,
  createBootstrapInvitation: mocks.createBootstrapInvitation,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
  createAdminClient: mocks.createAdminClient,
}));

import {
  InvitationVerificationRateLimitError,
  inviteWorkspaceMember,
  requestInvitationMailboxOtp,
} from "@/lib/auth/invitations";

function queryResult<T>(result: T) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "is", "gt", "order", "limit", "update"]) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn().mockResolvedValue(result);
  return query;
}

const invitationClaim = "c".repeat(43);
const invitation = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  invitation_kind: "workspace",
  email: "invitee@example.com",
  invited_user_id: null,
  role: "viewer",
  invited_by: "33333333-3333-4333-8333-333333333333",
  expires_at: "2099-01-01T00:00:00.000Z",
  accepted_at: null,
  revoked_at: null,
  signup_proof_hash: createHash("sha256").update(invitationClaim).digest("hex"),
  email_reverification_requested_at: null,
  created_at: "2026-08-16T00:00:00.000Z",
};

describe("invitation delivery and OTP lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend-test";
    process.env.INVITATION_FROM_EMAIL = "RefineStack <invite@example.com>";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });

  it("records and revokes a failed initial delivery so a retry is not blocked", async () => {
    const membershipQuery = queryResult({ data: { role: "admin" }, error: null });
    const rpc = vi.fn().mockResolvedValue({ data: { status: "failed" }, error: null });
    const admin = { rpc };
    mocks.createClient.mockResolvedValue({ from: vi.fn(() => membershipQuery) });
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.createInvitation.mockResolvedValue(invitation);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(inviteWorkspaceMember({
      actor: { workspaceId: invitation.workspace_id, userId: invitation.invited_by, role: "admin" },
      email: invitation.email,
      role: "viewer",
    })).rejects.toThrow("was revoked. Retry");

    expect(rpc).toHaveBeenCalledWith("record_invitation_notification_delivery", expect.objectContaining({
      p_invitation_id: invitation.id,
      p_succeeded: false,
      p_failure_code: "resend_http_503",
      p_actor_id: invitation.invited_by,
    }));
  });

  it("admits and finalizes exactly one mailbox OTP attempt", async () => {
    const invitationQuery = queryResult({ data: invitation, error: null });
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: { attempt_id: "44444444-4444-4444-8444-444444444444", email: invitation.email, should_create_user: true },
        error: null,
      })
      .mockResolvedValueOnce({ data: { status: "sent" }, error: null });
    const generateLink = vi.fn().mockResolvedValue({
      data: { properties: { action_link: "https://auth.example.com/verify?token=secret" } },
      error: null,
    });
    const admin = {
      from: vi.fn(() => invitationQuery),
      rpc,
      auth: { admin: {
        listUsers: vi.fn().mockResolvedValue({ data: { users: [] }, error: null }),
        generateLink,
      } },
    };
    mocks.createAdminClient.mockReturnValue(admin);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));

    await requestInvitationMailboxOtp(invitation.id, invitationClaim);

    expect(rpc).toHaveBeenNthCalledWith(1, "admit_invitation_mailbox_otp", expect.objectContaining({
      p_invitation_id: invitation.id,
      p_authenticated_user_id: null,
      p_existing_user_id: null,
    }));
    expect(generateLink).toHaveBeenCalledWith(expect.objectContaining({
      type: "magiclink",
      email: invitation.email,
      options: expect.objectContaining({
        redirectTo: "https://app.example.com/auth/callback?next=%2Faccept-invite%3Finvitation%3D11111111-1111-4111-8111-111111111111",
        data: { invitation_id: invitation.id, invitation_proof: invitationClaim },
      }),
    }));
    expect(fetch).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("Verify your RefineStack mailbox"),
    }));
    expect(rpc).toHaveBeenNthCalledWith(2, "finalize_invitation_mailbox_otp", expect.objectContaining({
      p_attempt_id: "44444444-4444-4444-8444-444444444444",
      p_succeeded: true,
    }));
  });

  it("does not send another OTP when the atomic admission reports an active window", async () => {
    const invitationQuery = queryResult({ data: invitation, error: null });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "55P03" } });
    const generateLink = vi.fn();
    const admin = {
      from: vi.fn(() => invitationQuery),
      rpc,
      auth: { admin: {
        listUsers: vi.fn().mockResolvedValue({ data: { users: [] }, error: null }),
        generateLink,
      } },
    };
    mocks.createAdminClient.mockReturnValue(admin);

    await expect(requestInvitationMailboxOtp(invitation.id, invitationClaim))
      .rejects.toBeInstanceOf(InvitationVerificationRateLimitError);
    expect(generateLink).not.toHaveBeenCalled();
  });

  it("records a provider failure without consuming the invitation claim", async () => {
    const invitationQuery = queryResult({ data: invitation, error: null });
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: { attempt_id: "44444444-4444-4444-8444-444444444444", email: invitation.email, should_create_user: true },
        error: null,
      })
      .mockResolvedValueOnce({ data: { status: "failed" }, error: null });
    const admin = {
      from: vi.fn(() => invitationQuery),
      rpc,
      auth: { admin: {
        listUsers: vi.fn().mockResolvedValue({ data: { users: [] }, error: null }),
        generateLink: vi.fn().mockResolvedValue({
          data: { properties: { action_link: "https://auth.example.com/verify?token=secret" } },
          error: null,
        }),
      } },
    };
    mocks.createAdminClient.mockReturnValue(admin);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(requestInvitationMailboxOtp(invitation.id, invitationClaim))
      .rejects.toThrow("could not be sent");

    expect(rpc).toHaveBeenNthCalledWith(2, "finalize_invitation_mailbox_otp", expect.objectContaining({
      p_succeeded: false,
      p_failure_code: "resend_http_503",
    }));
  });
});
