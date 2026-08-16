import type { ReactNode } from "react";
import Link from "next/link";

export function BidiText({ children }: { children: ReactNode }) {
  return <bdi dir="auto">{children}</bdi>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="workspace-page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1><BidiText>{title}</BidiText></h1>
        <p><BidiText>{description}</BidiText></p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="workspace-section-heading">
      <div>
        <h2><BidiText>{title}</BidiText></h2>
        {description ? <p><BidiText>{description}</BidiText></p> : null}
      </div>
      {action}
    </div>
  );
}

export function StatusChip({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "positive" | "warning" | "critical" | "info";
  children: ReactNode;
}) {
  return <span className={`status-chip status-${tone}`}>{children}</span>;
}

export function StatCard({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "accent";
}) {
  return (
    <article className={`stat-card ${tone === "accent" ? "stat-card-accent" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

export function EmptyState({
  eyebrow,
  title,
  description,
  actionHref,
  actionLabel,
  secondary,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
  secondary?: ReactNode;
}) {
  return (
    <section className="empty-state" aria-labelledby={`empty-${slug(title)}`}>
      <div className="empty-state-mark" aria-hidden="true">◌</div>
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h2 id={`empty-${slug(title)}`}><BidiText>{title}</BidiText></h2>
        <p><BidiText>{description}</BidiText></p>
        <div className="empty-actions">
          {actionHref && actionLabel ? (
            <Link className="button button-small" href={actionHref}>{actionLabel}</Link>
          ) : null}
          {secondary}
        </div>
      </div>
    </section>
  );
}

export function Notice({
  title,
  children,
  tone = "info",
}: {
  title: string;
  children: ReactNode;
  tone?: "info" | "warning" | "critical";
}) {
  return (
    <aside
      className={`notice notice-${tone}`}
      role={tone === "critical" ? "alert" : "status"}
      aria-live={tone === "critical" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <strong><BidiText>{title}</BidiText></strong>
      <div>{children}</div>
    </aside>
  );
}

export function DefinitionList({
  items,
}: {
  items: Array<{ term: string; detail: ReactNode }>;
}) {
  return (
    <dl className="definition-list">
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ProgressMeter({
  label,
  value,
  description,
}: {
  label: string;
  value: number;
  description: string;
}) {
  const safeValue = Math.max(0, Math.min(100, value));
  return (
    <div className="progress-meter">
      <div><strong>{label}</strong><span>{safeValue}%</span></div>
      <progress max="100" value={safeValue}>{safeValue}%</progress>
      <p>{description}</p>
    </div>
  );
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
