import { NextResponse, type NextRequest } from "next/server";
import { getPublicEnv } from "@/lib/env";

const accessCookie = "prominence-access-token";
const refreshCookie = "prominence-refresh-token";

async function currentAccessToken(request: NextRequest) {
  const token = request.cookies.get(accessCookie)?.value;
  const env = getPublicEnv();
  if (token) {
    const response = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
      cache: "no-store",
      headers: { apikey: env.supabasePublishableKey, Authorization: `Bearer ${token}` },
    });
    if (response.ok) return { token };
  }

  const refreshToken = request.cookies.get(refreshCookie)?.value;
  if (!refreshToken) return null;
  const refresh = await fetch(`${env.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    cache: "no-store",
    headers: { apikey: env.supabasePublishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!refresh.ok) return null;
  return await refresh.json() as { access_token: string; refresh_token: string; expires_in: number };
}

export async function updateSession(request: NextRequest) {
  const session = await currentAccessToken(request);
  const hasUser = Boolean(session);
  const isProtected = request.nextUrl.pathname.startsWith("/dashboard");
  const isAuthPage = request.nextUrl.pathname.startsWith("/login");

  if (!hasUser && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (hasUser && isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  if (session && "access_token" in session) {
    request.cookies.set(accessCookie, session.access_token);
    const response = NextResponse.next({ request });
    const secure = process.env.NODE_ENV === "production";
    response.cookies.set(accessCookie, session.access_token, {
      httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: session.expires_in,
    });
    response.cookies.set(refreshCookie, session.refresh_token, {
      httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  }

  return NextResponse.next();
}
