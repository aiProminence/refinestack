import Link from "next/link";
import { brand } from "@/lib/brand";
import { SubmitButton } from "@/components/submit-button";
import { requestPasswordReset, signIn, updatePassword } from "./actions";

export const metadata = { title: "Sign in" };

type LoginPageProps = {
  searchParams: Promise<{ mode?: string; error?: string; success?: string; next?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const mode = params.mode ?? "signin";
  const isForgot = mode === "forgot";
  const isUpdate = mode === "update-password";
  const action = isForgot ? requestPasswordReset : isUpdate ? updatePassword : signIn;
  const title = isForgot ? "Reset your password" : isUpdate ? "Choose a new password" : "Welcome back";
  const description = isForgot
    ? "We will send a one-time recovery link if the address has workspace access."
    : isUpdate
      ? "Use a unique password with at least 12 characters."
      : "Sign in to your recommendation-intelligence workspace.";

  return <main className="auth-page">
    <section className="auth-story">
      <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
      <div>
        <span className="eyebrow light">{brand.descriptor}</span>
        <h1>Evidence before scores.</h1>
        <p>Every metric begins with a real capture and preserves the provider, model, market, prompt and evidence behind it.</p>
      </div>
      <span className="eyebrow light">Controlled workspace access</span>
    </section>
    <section className="auth-panel">
      <form className="auth-form" action={action}>
        <span className="eyebrow">{brand.name} workspace</span>
        <h2>{title}</h2>
        <p>{description}</p>
        {!isUpdate && <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
        </div>}
        {!isForgot && <div className="field">
          <label htmlFor="password">{isUpdate ? "New password" : "Password"}</label>
          <input id="password" name="password" type="password" autoComplete={isUpdate ? "new-password" : "current-password"} minLength={isUpdate ? 12 : undefined} required />
        </div>}
        {isUpdate && <div className="field">
          <label htmlFor="passwordConfirmation">Confirm new password</label>
          <input id="passwordConfirmation" name="passwordConfirmation" type="password" autoComplete="new-password" minLength={12} required />
        </div>}
        {!isForgot && !isUpdate && <input type="hidden" name="next" value={params.next ?? "/dashboard"} />}
        <SubmitButton pendingLabel={isForgot ? "Sending secure link…" : isUpdate ? "Saving password…" : "Signing in…"}>{isForgot ? "Send secure reset link" : isUpdate ? "Save new password" : "Sign in"}</SubmitButton>
        {params.error && <div className="form-error" role="alert">{params.error}</div>}
        {params.success && <div className="form-success" role="status">{params.success}</div>}
        <div className="form-note">
          {isForgot || isUpdate
            ? <Link className="text-link" href="/login">Return to sign in</Link>
            : <>Invitation-only access. <Link className="text-link" href="/login?mode=forgot">Forgot password?</Link></>}
        </div>
      </form>
    </section>
  </main>;
}
