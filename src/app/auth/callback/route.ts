import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeRelativePath } from "@/lib/security/safe-next";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = safeRelativePath(url.searchParams.get("next"));
  const supabase = await createClient();

  let error: Error | null = null;
  if (code) {
    const result = await supabase.auth.exchangeCodeForSession(code);
    error = result.error;
  } else if (tokenHash && type) {
    const result = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    error = result.error;
  } else {
    error = new Error("Missing authentication token.");
  }

  if (error) {
    const failure = new URL("/login", url.origin);
    failure.searchParams.set("error", "This secure link is invalid or has expired.");
    return NextResponse.redirect(failure);
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
