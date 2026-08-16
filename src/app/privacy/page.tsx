import Link from "next/link";
import { brand } from "@/lib/brand";

export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return <main className="legal-page shell">
    <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
    <span className="eyebrow">Privacy notice · 16 August 2026</span>
    <h1>Customer evidence stays customer evidence.</h1>
    <p>RefineStack processes account details, workspace configuration, buyer questions, evidence sources, AI-provider responses, usage records and security logs to provide and protect the service.</p>
    <h2>How data is used</h2>
    <p>We use workspace data to authenticate users, run requested monitoring, calculate transparent metrics, deliver exports and webhooks, prevent abuse, diagnose failures and improve the reliability of the product. RefineStack does not sell customer data or use private workspace content to train a generalized RefineStack model.</p>
    <h2>Providers and location</h2>
    <p>When an authorized user runs monitoring, the approved question and necessary context are sent to the selected provider. Provider, model, access method, market and time are retained with each capture. Data may be processed where our hosting and selected AI providers operate.</p>
    <h2>Control and retention</h2>
    <p>Workspace owners can request an export, revoke tokens and integrations, remove members or request deletion. Raw captures and audit history are retained while the workspace is active because they support reproducibility. Legal, security or backup obligations may require a limited deletion period.</p>
    <h2>Contact</h2>
    <p>For access, correction or deletion requests, email <a className="text-link" href={`mailto:${brand.email}`}>{brand.email}</a>.</p>
  </main>;
}
