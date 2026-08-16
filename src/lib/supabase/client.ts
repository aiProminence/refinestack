"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getPublicEnv } from "@/lib/env";

export function createClient() {
  const env = getPublicEnv();
  return createBrowserClient(env.supabaseUrl, env.supabasePublishableKey);
}
