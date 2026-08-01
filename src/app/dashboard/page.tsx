import Link from "next/link";

export const metadata = { title: "Dashboard" };

export default function Dashboard() {
  return (
    <main style={{minHeight:"100vh",background:"#f5f0e7"}}>
      <header className="site-header shell">
        <Link className="wordmark" href="/">Prominence<span>.</span></Link>
        <span className="eyebrow">MVP workspace</span>
        <Link className="text-link" href="/">Exit dashboard</Link>
      </header>
      <section className="shell" style={{padding:"72px 0"}}>
        <span className="eyebrow">Observation ledger</span>
        <h1 style={{fontFamily:"Georgia,serif",fontSize:"clamp(42px,6vw,70px)",fontWeight:400,letterSpacing:"-.05em",lineHeight:1,margin:"18px 0"}}>No observations yet.</h1>
        <p className="hero-copy">Connect a supported provider and run a successful capture before Prominence calculates any recommendation metric.</p>
        <div className="metric-panel" style={{marginTop:56}}>
          <div><span className="metric-kicker">AI Recommendation Share</span><h2>Not calculated</h2></div>
          <div><span className="metric-kicker">Successful observations</span><h2>0</h2></div>
          <p>This honest empty state will be replaced by workspace-backed data in the provider integration milestone.</p>
        </div>
      </section>
    </main>
  );
}
