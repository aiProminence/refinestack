import type { ReactNode } from "react";
import { ProductShell } from "@/components/product-shell";
import { getProductSnapshot } from "@/lib/db";
import { getDashboardContext } from "./_context";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const ctx = await getDashboardContext();
  const snapshot = await getProductSnapshot(ctx);

  return (
    <ProductShell
      workspaceName={snapshot.workspace.name}
      role={ctx.actor.role}
    >
      {children}
    </ProductShell>
  );
}
