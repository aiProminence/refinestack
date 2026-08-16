import Link from "next/link";
import { brand } from "@/lib/brand";

export const metadata = { title: "Security" };

const controls = [
  ["Tenant boundaries", "Workspace-scoped authorization, row-level security and database constraints protect customer records."],
  ["Evidence integrity", "Raw captures remain immutable; classifications, reviews and metric versions retain their lineage."],
  ["Least privilege", "Roles, API-token scopes and approval boundaries limit reads, runs, exports and administrative work."],
  ["Secret safety", "Provider and administrative credentials stay server-side and are excluded from exports, logs and browser bundles."],
  ["Operational truth", "Partial work, retries, provider failures, coverage and costs remain visible instead of being reported as success."],
];

export default function SecurityPage() {
  return <main className="legal-page shell">
    <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
    <span className="eyebrow">Security</span>
    <h1>Trust is an inspectable system.</h1>
    <p>RefineStack is building its controls from the data model outward. We do not claim a security certification that has not been completed.</p>
    <div className="legal-grid">{controls.map(([title, body]) => <section key={title}><h2>{title}</h2><p>{body}</p></section>)}</div>
    <p>To report a vulnerability, contact <a className="text-link" href={`mailto:${brand.email}?subject=Security%20report`}>{brand.email}</a>. Do not include secrets or customer data in the first message.</p>
  </main>;
}
