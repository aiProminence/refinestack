import Link from "next/link";
import { redirect } from "next/navigation";
import { SubmitButton } from "@/components/submit-button";
import { brand } from "@/lib/brand";
import { safeRelativePath } from "@/lib/security/safe-next";
import { confirmMailboxLink } from "./actions";

export const metadata = { title: "Confirm mailbox" };
export const dynamic = "force-dynamic";

export default async function ConfirmMailboxPage({ searchParams }: {
  searchParams: Promise<{ token_hash?: string; next?: string }>;
}) {
  const params = await searchParams;
  const tokenHash = params.token_hash ?? "";
  if (!/^[A-Za-z0-9_-]{20,256}$/u.test(tokenHash)) {
    redirect("/login?error=This%20secure%20link%20is%20invalid%20or%20has%20expired.");
  }
  const next = safeRelativePath(params.next);

  return <main className="auth-page">
    <section className="auth-story">
      <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
      <div>
        <span className="eyebrow light">Protected verification</span>
        <h1>Your link is ready.</h1>
        <p>Email security scanners can inspect links automatically. This page keeps the one-time token unused until you confirm.</p>
      </div>
      <span className="eyebrow light">One deliberate click</span>
    </section>
    <section className="auth-panel">
      <form className="auth-form" action={confirmMailboxLink}>
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="next" value={next} />
        <span className="eyebrow">Mailbox confirmation</span>
        <h2>Continue to RefineStack</h2>
        <p>Press the button below to use this one-time verification and continue your invitation.</p>
        <SubmitButton pendingLabel="Verifying…">Confirm and continue</SubmitButton>
      </form>
    </section>
  </main>;
}
