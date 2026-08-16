import Link from "next/link";
import { redirect } from "next/navigation";
import { brand } from "@/lib/brand";
import { SubmitButton } from "@/components/submit-button";
import { getOpenInvitationByClaim, getPendingInvitationForCurrentUser, hasFreshMailboxVerification } from "@/lib/auth/invitations";
import { getUser } from "@/lib/supabase/server";
import { completeInvitation, sendFreshMailboxVerification, sendInvitationMailboxOtp } from "./actions";

export const metadata = { title: "Accept invitation" };

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ error?: string; invitation?: string; claim?: string }> }) {
  const [user, params] = await Promise.all([getUser(), searchParams]);
  if (!user) {
    const invitation = params.invitation && params.claim ? await getOpenInvitationByClaim(params.invitation, params.claim) : null;
    if (!invitation) redirect("/access-revoked");
    return <main className="auth-page"><section className="auth-story"><Link className="wordmark" href="/">{brand.name}<span>.</span></Link><div><span className="eyebrow light">Secure invitation</span><h1>Prove control of the invited mailbox.</h1><p>This notification is not a sign-in credential. A separate one-time authentication link will be sent to the address on the invitation.</p></div></section><section className="auth-panel"><form className="auth-form" action={sendInvitationMailboxOtp}><input type="hidden" name="invitationId" value={invitation.id} /><input type="hidden" name="claim" value={params.claim} /><span className="eyebrow">Mailbox confirmation</span><h2>Send a one-time sign-in link</h2><p>The link goes only to the invited address and expires after use. One verification window can be active at a time.</p><SubmitButton pendingLabel="Sending…">Verify invited mailbox</SubmitButton>{params.error && <div className="form-error" role="alert">{params.error}</div>}</form></section></main>;
  }
  const invitation = await getPendingInvitationForCurrentUser(params.invitation);
  if (!invitation || (params.invitation && params.invitation !== invitation.id)) redirect("/access-revoked");
  const mailboxVerified = await hasFreshMailboxVerification(invitation.email_reverification_requested_at);
  const createdForInvitation = user.user_metadata?.invitation_id === invitation.id;

  return <main className="auth-page">
    <section className="auth-story">
      <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
      <div>
        <span className="eyebrow light">Secure invitation</span>
        <h1>Enter through the evidence door.</h1>
        <p>Your mailbox-bound invitation has been verified. Set your profile and password to enter the assigned workspace.</p>
      </div>
      <span className="eyebrow light">One-time acceptance</span>
    </section>
    <section className="auth-panel">
      {!mailboxVerified ? <form className="auth-form" action={sendFreshMailboxVerification}>
        <input type="hidden" name="invitationId" value={invitation.id} />
        <span className="eyebrow">Mailbox confirmation</span>
        <h2>Verify this invitation again</h2>
        <p>We will send a fresh, one-time link to {user.email}. This prevents a forwarded invitation link from taking over the account.</p>
        <SubmitButton pendingLabel="Sending…">Send fresh verification link</SubmitButton>
        {params.error && <div className="form-error" role="alert">{params.error}</div>}
      </form> : <form className="auth-form" action={completeInvitation}>
        <input type="hidden" name="invitationId" value={invitation.id} />
        <span className="eyebrow">{brand.name} workspace</span>
        <h2>Complete your account</h2>
        <p>Invited as {user.email}. The invitation cannot be transferred to another address.</p>
        <div className="field"><label htmlFor="fullName">Full name</label><input id="fullName" name="fullName" autoComplete="name" required={createdForInvitation} /></div>
        {createdForInvitation ? <><div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required /></div><div className="field"><label htmlFor="passwordConfirmation">Confirm password</label><input id="passwordConfirmation" name="passwordConfirmation" type="password" autoComplete="new-password" minLength={12} required /></div></> : <p>Your existing password and sessions are unchanged. This action adds only the invited workspace role.</p>}
        <SubmitButton pendingLabel="Securing account…">Enter workspace</SubmitButton>
        {params.error && <div className="form-error" role="alert">{params.error}</div>}
      </form>}
    </section>
  </main>;
}
