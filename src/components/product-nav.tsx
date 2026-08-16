"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { WorkspaceRole } from "@/types/contracts";

const navigation = [
  {
    label: "Monitor",
    items: [
      { href: "/dashboard", label: "Overview", exact: true },
      { href: "/dashboard/answers", label: "AI answers" },
      { href: "/dashboard/runs", label: "Monitoring runs" },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { href: "/dashboard/analytics", label: "Visibility analytics" },
      { href: "/dashboard/decisions", label: "Decision map" },
      { href: "/dashboard/analytics/competitors", label: "Competitors" },
      { href: "/dashboard/analytics/evidence", label: "Citation intelligence" },
    ],
  },
  {
    label: "Improve",
    items: [
      { href: "/dashboard/actions", label: "Action queue" },
      { href: "/dashboard/evidence", label: "Evidence library" },
      { href: "/dashboard/questions", label: "Prompt library" },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "/dashboard/setup", label: "Project setup" },
      { href: "/dashboard/operations", label: "Operations" },
      { href: "/dashboard/usage", label: "Usage" },
      { href: "/dashboard/team", label: "Team" },
      { href: "/dashboard/settings", label: "Settings" },
    ],
  },
] as const;

function isActive(pathname: string, href: string, exact?: boolean) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function NavContents({ onMobile = false, role }: { onMobile?: boolean; role: WorkspaceRole }) {
  const pathname = usePathname();
  return (
    <nav className={onMobile ? "mobile-nav-groups" : "workspace-nav-groups"} aria-label={onMobile ? "Mobile workspace" : "Workspace"}>
      {navigation.map((group) => (
        <section key={group.label} aria-labelledby={`${onMobile ? "mobile-" : ""}nav-${group.label.toLowerCase().replaceAll(" ", "-")}`}>
          <p className="nav-group-label" id={`${onMobile ? "mobile-" : ""}nav-${group.label.toLowerCase().replaceAll(" ", "-")}`}>{group.label}</p>
          <ul>
            {group.items.filter((item) => item.href !== "/dashboard/settings" || role === "owner" || role === "admin").map((item) => {
              const active = isActive(pathname, item.href, "exact" in item ? item.exact : false);
              return (
                <li key={item.href}>
                  <Link href={item.href} aria-current={active ? "page" : undefined}>{item.label}</Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}

export function ProductNav({ role }: { role: WorkspaceRole }) {
  return <NavContents role={role} />;
}

export function MobileProductNav({ role }: { role: WorkspaceRole }) {
  return (
    <details className="mobile-product-nav">
      <summary>Workspace menu</summary>
      <NavContents onMobile role={role} />
    </details>
  );
}
