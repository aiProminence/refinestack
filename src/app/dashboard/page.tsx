import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { brand } from "@/lib/brand";
import { getUser, getWorkspace } from "@/lib/supabase/server";

export const metadata = { title: "Dashboard" };

export default async function Dashboard() {
  const user = await getUser();

  if (!user) redirect("/login");

  const membership = await getWorkspace();

  return (
    <main style={{minHeight:"100vh",background:"#f5f0e7"}}>
      <header className="site-header shell">
        <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
        <span className="eyebrow">{membership?.workspaces?.name ?? "MVP workspace"}</span>
        <form action={signOut}><button className="text-link link-button" type="submit">Sign out</button></form>
      </header>
      <section className="shell" style={{padding:"72px 0"}}>
        <span className="eyebrow">Observation ledger</span>
        <h1 style={{fontFamily:"Georgia,serif",fontSize:"clamp(42px,6vw,70px)",fontWeight:400,letterSpacing:"-.05em",lineHeight:1,margin:"18px 0"}}>No observations yet.</h1>
        <p className="hero-copy">Connect a supported provider and run a successful capture before {brand.name} calculates any recommendation metric.</p>
        <div className="metric-panel" style={{marginTop:56}}>
          <div><span className="metric-kicker">AI Recommendation Share</span><h2>Not calculated</h2></div>
          <div><span className="metric-kicker">Successful observations</span><h2>0</h2></div>
          <p>Signed in as {user.email}. Captures will appear here only after a provider returns a successful, provenance-backed observation.</p>
        </div>
      </section>
    </main>
  );
}
