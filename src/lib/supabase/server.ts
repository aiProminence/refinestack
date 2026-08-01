import { cookies } from "next/headers";
import { getPublicEnv } from "@/lib/env";

const ACCESS_COOKIE = "prominence-access-token";
const REFRESH_COOKIE = "prominence-refresh-token";

type AuthUser = { id: string; email?: string; user_metadata?: { full_name?: string } };
type AuthSession = { access_token: string; refresh_token: string; expires_in: number; user: AuthUser };

async function authFetch(path: string, init: RequestInit = {}) {
  const env = getPublicEnv();
  return fetch(`${env.supabaseUrl}/auth/v1${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      apikey: env.supabasePublishableKey,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

async function writeSession(session: AuthSession) {
  const cookieStore = await cookies();
  const secure = process.env.NODE_ENV === "production";
  cookieStore.set(ACCESS_COOKIE, session.access_token, {
    httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: session.expires_in,
  });
  cookieStore.set(REFRESH_COOKIE, session.refresh_token, {
    httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
}

async function parseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return String(body.msg ?? body.message ?? body.error_description ?? "Authentication failed.");
}

export async function signInWithPassword(email: string, password: string) {
  const response = await authFetch("/token?grant_type=password", {
    method: "POST", body: JSON.stringify({ email, password }),
  });
  if (!response.ok) return { error: await parseError(response) };
  const session = await response.json() as AuthSession;
  await writeSession(session);
  return { user: session.user };
}

export async function signUpWithPassword(email: string, password: string, fullName: string) {
  const response = await authFetch("/signup", {
    method: "POST",
    body: JSON.stringify({ email, password, data: { full_name: fullName } }),
  });
  if (!response.ok) return { error: await parseError(response) };
  const result = await response.json() as Partial<AuthSession> & { user: AuthUser };
  if (result.access_token && result.refresh_token && result.expires_in) {
    await writeSession(result as AuthSession);
  }
  return { user: result.user, hasSession: Boolean(result.access_token) };
}

export async function getUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  const response = await authFetch("/user", { headers: { Authorization: `Bearer ${token}` } });
  return response.ok ? await response.json() as AuthUser : null;
}

export async function getWorkspace(token?: string) {
  const cookieStore = await cookies();
  const accessToken = token ?? cookieStore.get(ACCESS_COOKIE)?.value;
  if (!accessToken) return null;
  const env = getPublicEnv();
  const response = await fetch(
    `${env.supabaseUrl}/rest/v1/workspace_members?select=role,workspaces(id,name,slug)&limit=1`,
    { cache: "no-store", headers: { apikey: env.supabasePublishableKey, Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) return null;
  const memberships = await response.json() as Array<{ role: string; workspaces: { id: string; name: string; slug: string } | null }>;
  return memberships[0] ?? null;
}

export async function signOutSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ACCESS_COOKIE)?.value;
  if (token) await authFetch("/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  cookieStore.delete(ACCESS_COOKIE);
  cookieStore.delete(REFRESH_COOKIE);
}

export const authCookieNames = { access: ACCESS_COOKIE, refresh: REFRESH_COOKIE };
