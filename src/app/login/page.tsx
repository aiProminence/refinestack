import Link from "next/link";
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
        <Link className="wordmark" href="/">Prominence<span>.</span></Link>
        <div>
          <span className="eyebrow light">AI recommendation intelligence</span>
          <h1>Evidence before scores.</h1>
          <p>Every Prominence metric begins with a successful provider capture and preserves its source, method and timestamp.</p>
        </div>
        <span className="eyebrow light">Private MVP access</span>
      </section>
      <section className="auth-panel">
        <form className="auth-form" action={isSignUp ? signUp : signIn}>
          <span className="eyebrow">Prominence workspace</span>
          <h2>{isSignUp ? "Create your account" : "Welcome back"}</h2>
          <p>{isSignUp ? "Your private workspace is created automatically." : "Sign in to your observation ledger."}</p>
          {isSignUp && <div className="field"><label htmlFor="fullName">Full name</label><input id="fullName" name="fullName" autoComplete="name" required /></div>}
          <div className="field"><label htmlFor="email">Work email</label><input id="email" name="email" type="email" autoComplete="email" required /></div>
          <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete={isSignUp ? "new-password" : "current-password"} minLength={10} required /></div>
          <button className="button" type="submit">{isSignUp ? "Create workspace" : "Sign in"}</button>
          {params.error && <div className="form-error" role="alert">{params.error}</div>}
          {params.success && <div className="form-success" role="status">{params.success}</div>}
          <div className="form-note">{isSignUp ? "Already have access?" : "New to Prominence?"} <Link className="text-link" href={isSignUp ? "/login" : "/login?mode=signup"}>{isSignUp ? "Sign in" : "Create an account"}</Link></div>
        </form>
      </section>
    </main>
  );
}
