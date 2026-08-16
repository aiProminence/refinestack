import Link from "next/link";
import { brand } from "@/lib/brand";

export const metadata = { title: "Terms" };

export default function TermsPage() {
  return <main className="legal-page shell">
    <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
    <span className="eyebrow">Service terms · 16 August 2026</span>
    <h1>Use intelligence with judgement.</h1>
    <p>RefineStack measures outputs from configured AI and search providers. Those outputs may be incomplete, inconsistent or wrong. The service preserves evidence and uncertainty to support decisions, but it does not replace professional, legal, financial or commercial judgement.</p>
    <h2>Authorized use</h2>
    <p>You must have authority to submit workspace data and evidence, keep access credentials secure, respect provider and source terms, and avoid unlawful, deceptive, abusive or privacy-invasive use. You are responsible for reviewing any intervention before acting on it.</p>
    <h2>Service behavior</h2>
    <p>Provider availability, models and search surfaces can change. Failed and unavailable captures remain auditable and are excluded from answer-based denominators. RefineStack will not fabricate a result to fill a provider gap.</p>
    <h2>Customer data</h2>
    <p>You retain ownership of your submitted data and exports. You grant RefineStack the limited right to process it to operate, secure and support the service. Access ends when an invitation, membership or token is revoked.</p>
    <h2>Contact</h2>
    <p>Questions about these terms can be sent to <a className="text-link" href={`mailto:${brand.email}`}>{brand.email}</a>.</p>
  </main>;
}
