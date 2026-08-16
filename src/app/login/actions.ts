"use server";

import { redirect } from "next/navigation";
import { brand } from "@/lib/brand";
import { safeRelativePath } from "@/lib/security/safe-next";
import { createClient, signOutSession } from "@/lib/supabase/server";

function destination(kind: "error" | "success", message: string, mode?: string) {
  const params = new URLSearchParams({ [kind]: message });
  if (mode) params.set("mode", mode);
  return `/login?${params.toString()}`;
}

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeRelativePath(formData.get("next"));
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) redirect(destination("error", "The email or password is incorrect."));
  redirect(next);
}

export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const supabase = await createClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? `https://${brand.domain}`;
  const callbackUrl = new URL("/auth/callback", appUrl);
  callbackUrl.searchParams.set("next", "/login?mode=update-password");
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: callbackUrl.toString(),
  });

  redirect(destination("success", "If that address has access, a secure reset link is on its way.", "forgot"));
}

export async function updatePassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("passwordConfirmation") ?? "");
  if (password.length < 12) redirect(destination("error", "Use at least 12 characters.", "update-password"));
  if (password !== confirmation) redirect(destination("error", "The passwords do not match.", "update-password"));

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) redirect(destination("error", "This reset link is invalid or has expired.", "update-password"));
  redirect("/dashboard");
}

export async function signOut() {
  await signOutSession();
  redirect("/");
}
