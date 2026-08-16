import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { brand } from "@/lib/brand";
import { MobileProductNav, ProductNav } from "@/components/product-nav";
import { OperatorPanel } from "@/components/operator-panel";
import { BidiText } from "@/components/product-ui";
import type { WorkspaceRole } from "@/types/contracts";

export function ProductShell({
  children,
  workspaceName,
  role,
}: {
  children: ReactNode;
  workspaceName: string;
  role: WorkspaceRole;
}) {
  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="workspace-sidebar">
        <Link className="wordmark workspace-wordmark" href="/dashboard">{brand.name}<span>.</span></Link>
        <div className="workspace-identity">
          <span>Workspace</span>
          <strong><BidiText>{workspaceName}</BidiText></strong>
        </div>
        <ProductNav role={role} />
        <div className="sidebar-foot">
          <p><span className="sr-only">Workspace role: </span>{role}</p>
          <form action={signOut}><button className="text-link link-button" type="submit">Sign out</button></form>
        </div>
      </aside>
      <div className="workspace-main-column">
        <header className="workspace-mobile-header">
          <div className="workspace-mobile-identity">
            <Link className="wordmark mobile-wordmark" href="/dashboard" aria-label={`${brand.name} workspace home`}><span className="mobile-brand-full" aria-hidden="true">{brand.name}</span><span className="mobile-brand-compact" aria-hidden="true">R</span><span aria-hidden="true">.</span></Link>
            <span><BidiText>{workspaceName}</BidiText></span>
          </div>
          <div className="workspace-mobile-actions">
            <form action={signOut}><button className="mobile-signout" type="submit">Sign out</button></form>
            <MobileProductNav role={role} />
          </div>
        </header>
        <main id="main-content" className="workspace-content" tabIndex={-1}>{children}</main>
      </div>
      <OperatorPanel />
    </div>
  );
}
