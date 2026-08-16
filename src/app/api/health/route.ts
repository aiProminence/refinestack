import { brand } from "@/lib/brand";
import { operationalSecretState } from "@/lib/worker/auth";

export const dynamic = "force-dynamic";

type CheckState = "healthy" | "unavailable" | "unconfigured" | "invalid";

function adminCredential() {
  return process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function encryptionState(): CheckState {
  const value = process.env.APP_ENCRYPTION_KEY;
  if (!value) return "unconfigured";
  try {
    const key = /^[0-9a-f]{64}$/iu.test(value)
      ? Buffer.from(value, "hex")
      : Buffer.from(value, "base64url");
    return key.length === 32 ? "healthy" : "invalid";
  } catch {
    return "invalid";
  }
}

async function databaseState(url: string | undefined, secret: string | undefined): Promise<CheckState> {
  if (!url || !secret) return "unconfigured";
  try {
    const headers: Record<string, string> = { apikey: secret, accept: "application/json" };
    if (secret.split(".").length === 3) headers.authorization = `Bearer ${secret}`;
    const response = await fetch(`${url}/rest/v1/workspaces?select=id&limit=1`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
      headers,
    });
    return response.ok ? "healthy" : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function authenticationState(url: string | undefined, publishableKey: string | undefined): Promise<CheckState> {
  if (!url || !publishableKey) return "unconfigured";
  try {
    const response = await fetch(`${url}/auth/v1/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
      headers: { apikey: publishableKey },
    });
    return response.ok ? "healthy" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function GET() {
  const started = Date.now();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = adminCredential();
  const [database, authentication] = await Promise.all([
    databaseState(url, secret),
    authenticationState(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
  ]);
  const worker: CheckState = operationalSecretState();
  const encryption = encryptionState();
  const providers = {
    openai: Boolean(process.env.OPENAI_API_KEY),
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    google_ai_overview: Boolean(process.env.SERPAPI_API_KEY),
  };
  const providerReady = Object.values(providers).some(Boolean);
  const ready = database === "healthy" && authentication === "healthy" && worker === "healthy" && encryption === "healthy" && providerReady;

  return Response.json({
    service: brand.name,
    status: ready ? "ready" : "degraded",
    checks: { database, authentication, worker, encryption, providers },
    latencyMs: Date.now() - started,
    timestamp: new Date().toISOString(),
  }, {
    status: ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
