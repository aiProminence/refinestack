import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import type { DbContext } from "@/lib/db";
import { createClient, getUser, getWorkspace } from "@/lib/supabase/server";

export const getDashboardContext = cache(async (): Promise<DbContext> => {
  const [client, user, membership] = await Promise.all([
    createClient(),
    getUser(),
    getWorkspace(),
  ]);

  if (!user) redirect("/login");
  const workspace = Array.isArray(membership?.workspaces)
    ? membership.workspaces[0]
    : membership?.workspaces;
  if (!workspace || !membership?.role) redirect("/onboarding");

  return {
    client,
    actor: {
      userId: user.id,
      workspaceId: workspace.id,
      role: membership.role,
    },
  };
});

export function canWrite(role: DbContext["actor"]["role"]) {
  return role === "owner" || role === "admin" || role === "analyst";
}

export function canAdminister(role: DbContext["actor"]["role"]) {
  return role === "owner" || role === "admin";
}
