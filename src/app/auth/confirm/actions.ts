"use server";

import { redirect } from "next/navigation";
import { safeRelativePath } from "@/lib/security/safe-next";
import { createClient } from "@/lib/supabase/server";

function failurePath() {
  return "/login?error=This%20secure%20link%20is%20invalid%20or%20has%20expired.";
}

export async function confirmMailboxLink(formData: FormData) {
  const tokenHash = String(formData.get("token_hash") ?? "");
  const next = safeRelativePath(formData.get("next"));
  if (!/^[A-Za-z0-9_-]{20,256}$/u.test(tokenHash)) redirect(failurePath());

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (error) redirect(failurePath());
  redirect(next);
}
