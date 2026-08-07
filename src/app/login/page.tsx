import Link from "next/link";
import { brand } from "@/lib/brand";
import { signIn, signUp } from "./actions";

export const metadata = { title: "Sign in" };

type LoginPageProps = {
  searchParams: Promise<{ mode?: string; error?: string; success?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const isSignUp = params.mode === "signup";

  return (
    <main className="auth-page">
      <section className="auth-story">
        <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
        <div>
          <span className="eyebrow light">{brand.descriptor}</span>
          <h1>Evidence before scores.</h1>
          <p>Every {brand.name} metric begins with a successful provider capture and preserves its source, method and timestamp.</p>
        </div>
        <span className="eyebrow light">Private MVP access</span>
      </section>
      <section className="auth-panel">
        <form className="auth-form" action={isSignUp ? signUp : signIn}>
          <span className="eyebrow">{brand.name} workspace</span>
          <h2>{isSignUp ? "Accept your invitation" : "Welcome back"}</h2>
          <p>{isSignUp ? "Use the work email included in your private-beta invitation." : "Sign in to your observation ledger."}</p>
          {isSignUp && <div className="field"><label htmlFor="fullName">Full name</label><input id="fullName" name="fullName" autoComplete="name" required /></div>}
          <div className="field"><label htmlFor="email">Work email</label><input id="email" name="email" type="email" autoComplete="email" required /></div>
          <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete={isSignUp ? "new-password" : "current-password"} minLength={10} required /></div>
          <button className="button" type="submit">{isSignUp ? "Create invited account" : "Sign in"}</button>
          {params.error && <div className="form-error" role="alert">{params.error}</div>}
          {params.success && <div className="form-success" role="status">{params.success}</div>}
          <div className="form-note">
            {isSignUp ? (
              <>Already have access? <Link className="text-link" href="/login">Sign in</Link></>
            ) : (
              <>Private beta access is invitation-only. <a className="text-link" href={`mailto:${brand.email}?subject=${encodeURIComponent(`${brand.name} private beta`)}`}>Request access</a></>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}
