"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { WorkspaceRole } from "@/types/contracts";

const navigation = [
  {
    label: "Understand",
    items: [
      { href: "/dashboard", label: "Overview", exact: true },
      { href: "/dashboard/decisions", label: "Decision map" },
      { href: "/dashboard/answers", label: "Live answers" },
    ],
  },
  {
    label: "Build the study",
    items: [
      { href: "/dashboard/setup", label: "Project setup" },
      { href: "/dashboard/questions", label: "Questions" },
      { href: "/dashboard/evidence", label: "Evidence" },
    ],
  },
  {
    label: "Operate",
    items: [
      { href: "/dashboard/runs", label: "Monitoring runs" },
      { href: "/dashboard/actions", label: "Action backlog" },
      { href: "/dashboard/analytics", label: "Analytics" },
      { href: "/dashboard/operations", label: "Operations" },
    ],
  },
  {
    label: "Manage",
    items: [
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
