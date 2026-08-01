"use server";

import { redirect } from "next/navigation";
import { signInWithPassword, signOutSession, signUpWithPassword } from "@/lib/supabase/server";

function destination(kind: "error" | "success", message: string) {
  return `/login?${kind}=${encodeURIComponent(message)}`;
}

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const { error } = await signInWithPassword(email, password);

  if (error) redirect(destination("error", error));
  redirect("/dashboard");
}

export async function signUp(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const fullName = String(formData.get("fullName") ?? "").trim();

  if (password.length < 10) redirect(destination("error", "Use at least 10 characters for your password."));

  const { error, hasSession } = await signUpWithPassword(email, password, fullName);

  if (error) redirect(destination("error", error));
  if (hasSession) redirect("/dashboard");
  redirect(destination("success", "Check your email to confirm your account."));
}

export async function signOut() {
  await signOutSession();
  redirect("/");
}
