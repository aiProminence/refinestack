import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimsHaveFreshMailboxOtp } from "@/lib/auth/verification";

describe("invitation mailbox reverification", () => {
  it("accepts only an OTP authentication newer than the request", () => {
    expect(claimsHaveFreshMailboxOtp({ amr: [{ method: "otp", timestamp: 1_700_000_010 }] }, "2023-11-14T22:13:25.000Z")).toBe(true);
    expect(claimsHaveFreshMailboxOtp({ amr: [{ method: "otp", timestamp: 1_700_000_000 }] }, "2023-11-14T22:13:25.000Z")).toBe(false);
    expect(claimsHaveFreshMailboxOtp({ amr: [{ method: "password", timestamp: 1_700_000_100 }] }, "2023-11-14T22:13:25.000Z")).toBe(false);
  });

  it("keeps delivery and OTP admission service-only, atomic, bounded, and claim-consuming", () => {
    const migration = fs.readFileSync(path.resolve(
      "supabase/migrations/20260816154000_harden_invitation_delivery_admission.sql",
    ), "utf8");
    expect(migration).toContain("where id = p_invitation_id for update");
    expect(migration).toContain("otp_admitted_at > now() - interval '15 minutes'");
    expect(migration).toContain("otp_last_attempted_at > now() - interval '60 seconds'");
    expect(migration).toContain("signup_proof_consumed_at");
    expect(migration).toContain("notification_delivery_status = case when p_succeeded then 'sent' else 'failed' end");
    expect(migration).toContain("revoked_at = case when p_succeeded then revoked_at else coalesce(revoked_at, now()) end");
    expect(migration).toContain("private.invitation_delivery_events");
    expect(migration).toContain("revoke all on function public.admit_invitation_mailbox_otp(uuid, text, uuid, uuid)");
    expect(migration).toContain("grant execute on function public.admit_invitation_mailbox_otp(uuid, text, uuid, uuid)\nto service_role");
  });
});
