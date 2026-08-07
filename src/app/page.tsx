import Link from "next/link";
import { brand } from "@/lib/brand";

const capabilities = [
  ["Observe", "Capture answers from configured AI and search providers with source, model, market and timestamp provenance."],
  ["Classify", "Separate explicit recommendations from mentions and citations so visibility is never mistaken for preference."],
  ["Improve", "Turn the evidence behind each answer into a prioritised, auditable intervention backlog."],
];

export default function Home() {
  return (
    <main>
      <header className="site-header shell">
        <Link className="wordmark" href="/" aria-label={`${brand.name} home`}>{brand.name}<span>.</span></Link>
        <nav aria-label="Primary navigation">
          <a href="#method">Method</a>
          <Link href="/dashboard">Dashboard</Link>
        </nav>
        <a className="button button-small" href="#access">Request access</a>
      </header>

      <section className="hero shell">
        <div className="eyebrow">{brand.descriptor}</div>
        <h1>{brand.promise}</h1>
        <p className="hero-copy">{brand.name} measures explicit brand recommendations across configured AI surfaces, preserves the evidence behind every observation, and reveals where your brand can earn a stronger position.</p>
        <div className="hero-actions">
          <a className="button" href="#access">Join the private beta</a>
          <Link className="text-link" href="/dashboard">View the product foundation <span>↗</span></Link>
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

      <section className="method shell" id="method">
        <div className="section-heading">
          <span className="eyebrow">A defensible method</span>
          <h2>From answer capture to decision intelligence.</h2>
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

      <section className="truth shell">
        <div>
          <span className="eyebrow light">Product status</span>
          <h2>Built on observations, not invented scores.</h2>
        </div>
        <p>{brand.name} is in private MVP development. The application will only display a metric when a real provider is configured and a successful, provenance-backed observation exists.</p>
      </section>

      <section className="access shell" id="access">
        <span className="eyebrow">Private beta</span>
        <h2>Help shape the standard for AI recommendation measurement.</h2>
        <a className="button" href={`mailto:${brand.email}?subject=${encodeURIComponent(`${brand.name} private beta`)}`}>Request early access</a>
      </section>

      <footer className="shell">
        <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
        <p>{brand.descriptor} · Private MVP</p>
      </footer>
    </main>
  );
}
