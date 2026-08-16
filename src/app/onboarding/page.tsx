import Link from "next/link";
import { redirect } from "next/navigation";
import { createFirstWorkspace } from "./actions";
import { brand } from "@/lib/brand";
import { SubmitButton } from "@/components/submit-button";
import { getPendingInvitationForCurrentUser } from "@/lib/auth/invitations";
import { getUser, getWorkspace } from "@/lib/supabase/server";

export const metadata = { title: "Create workspace" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await getUser();
  if (!user) redirect("/login?next=/onboarding");
  if (await getWorkspace()) redirect("/dashboard");
  const invitation = await getPendingInvitationForCurrentUser();
  if (!invitation) redirect("/access-revoked");
  if (invitation.invitation_kind === "workspace") redirect(`/accept-invite?invitation=${encodeURIComponent(invitation.id)}`);
  const params = await searchParams;

  return <main className="auth-page">
    <section className="auth-story">
      <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
      <div><span className="eyebrow light">Workspace foundation</span><h1>Give the evidence a secure home.</h1><p>Create the first tenant boundary before adding a project, questions, evidence, or provider access.</p></div>
    </section>
    <section className="auth-panel">
      <form className="auth-form" action={createFirstWorkspace}>
        <span className="eyebrow">One-time setup</span>
        <h2>Create your workspace</h2>
        <p>You will become its owner. Team members join through mailbox-bound invitations.</p>
        <div className="field"><label htmlFor="workspace-name">Workspace name</label><input id="workspace-name" name="workspaceName" minLength={2} maxLength={120} required autoComplete="organization" /></div>
        {params.error ? <div className="form-error" role="alert">{params.error}</div> : null}
        <SubmitButton pendingLabel="Creating workspace…">Create workspace</SubmitButton>
      </form>
    </section>
  </main>;
}
