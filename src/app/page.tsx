import Link from "next/link";
import { brand } from "@/lib/brand";

const capabilities = [
  ["Decision Map", "See where your brand is won, lost, absent or unstable across the buyer questions that shape a shortlist."],
  ["Live Evidence", "Open the exact answer, recommendation, citation and source behind every score instead of trusting a black box."],
  ["Action Queue", "Turn competitive gaps into prioritised, auditable interventions and measure what changed after publishing."],
];

export default function Home() {
  return (
    <main>
      <header className="site-header shell">
        <Link className="wordmark" href="/" aria-label={`${brand.name} home`}>{brand.name}<span>.</span></Link>
        <nav aria-label="Primary navigation">
          <a href="#method">Method</a>
          <a href="#platform">Platform</a>
          <Link href="/dashboard">Dashboard</Link>
        </nav>
        <a className="button button-small" href="#access">Request access</a>
      </header>

      <section className="hero shell">
        <div className="eyebrow">AI visibility and recommendation intelligence</div>
        <h1>Become prominent where AI shapes the shortlist.</h1>
        <p className="hero-copy">{brand.name} shows how ChatGPT, Google AI surfaces and other configured providers talk about your category, which brands they recommend, what evidence they trust, and where you can earn a stronger position.</p>
        <div className="hero-actions">
          <a className="button" href="#access">Join the private beta</a>
          <Link className="text-link" href="/dashboard">Open AI visibility dashboard <span>↗</span></Link>
        </div>
        <div className="metric-panel" aria-label="AI Recommendation Share definition">
          <div>
            <span className="metric-kicker">Primary measure</span>
            <h2>AI Recommendation Share</h2>
          </div>
          <div className="formula">
            <strong>Explicit recommendations for your brand</strong>
            <span>÷</span>
            <strong>All captured brand recommendations</strong>
          </div>
          <p>Mentions and citations are reported separately. Failed captures never enter the denominator.</p>
        </div>
      </section>

      <section className="method shell" id="platform">
        <div className="section-heading">
          <span className="eyebrow">One operating system for AI visibility</span>
          <h2>Monitor the answers. Diagnose the gap. Improve the outcome.</h2>
        </div>
        <div className="capability-grid">
          {capabilities.map(([title, body], index) => (
            <article key={title}>
              <span>0{index + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="platform-strip shell" aria-label="Refinestack workflow">
        <p><span>01</span> Discover the prompts that matter</p>
        <p><span>02</span> Monitor AI answers and citations</p>
        <p><span>03</span> Compare competitors and evidence</p>
        <p><span>04</span> Act, retest and measure movement</p>
      </section>

      <section className="truth shell" id="method">
        <div>
          <span className="eyebrow light">Evidence standard</span>
          <h2>Built on observations, not invented scores.</h2>
        </div>
        <p>The application only displays a metric when a real provider is configured and a successful, provenance-backed observation exists. Failed and unavailable captures remain visible but never inflate an answer-rate denominator.</p>
      </section>

      <section className="access shell" id="access">
        <span className="eyebrow">Private beta</span>
        <h2>Help shape the standard for AI recommendation measurement.</h2>
        <a className="button" href={`mailto:${brand.email}?subject=${encodeURIComponent(`${brand.name} private beta`)}`}>Request early access</a>
      </section>

      <footer className="shell">
        <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
        <p>{brand.descriptor}</p>
        <nav aria-label="Legal navigation"><Link href="/privacy">Privacy</Link><Link href="/security">Security</Link><Link href="/terms">Terms</Link></nav>
      </footer>
    </main>
  );
}
