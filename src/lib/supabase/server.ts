import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getPublicEnv } from "@/lib/env";
import type { Database } from "@/types/database";

export async function createClient() {
  const cookieStore = await cookies();
  const env = getPublicEnv();

  return createServerClient<Database>(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot write cookies. The request proxy refreshes them.
        }
      },
    },
  });
}

export function createAdminClient() {
  const env = getPublicEnv();
  const secret = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Supabase admin operations are not configured.");

  return createSupabaseClient<Database>(env.supabaseUrl, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function getUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
}

export async function getClaims() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  return error ? null : data?.claims ?? null;
}

export async function getWorkspace() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_members")
    .select("role,workspaces(id,name,slug)")
    .limit(1)
    .maybeSingle();
  return error ? null : data;
}

export async function signInWithPassword(email: string, password: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return error ? { error: error.message } : { user: data.user };
}

export async function signOutSession() {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
}
