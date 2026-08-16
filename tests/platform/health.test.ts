import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";

const requiredNames = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_ENCRYPTION_KEY",
  "WORKER_SECRET",
  "CRON_SECRET",
  "OPENAI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "SERPAPI_API_KEY",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function clearReadinessEnvironment() {
  requiredNames.forEach((name) => vi.stubEnv(name, ""));
}

describe("health readiness", () => {
  it("stays degraded when operational credentials are missing", async () => {
    clearReadinessEnvironment();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      checks: { database: "unconfigured", authentication: "unconfigured", worker: "unconfigured", encryption: "unconfigured" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports ready only after the application database and runtime prerequisites pass", async () => {
    clearReadinessEnvironment();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test_value");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test_value");
    vi.stubEnv("APP_ENCRYPTION_KEY", "11".repeat(32));
    vi.stubEnv("WORKER_SECRET", "mH7N2pQ9xT4vK8cR6zL3sW5yB1dF0gJa");
    vi.stubEnv("OPENAI_API_KEY", "provider-secret");
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      checks: {
        database: "healthy",
        authentication: "healthy",
        worker: "healthy",
        encryption: "healthy",
        providers: { openai: true, claude: false, google_ai_overview: false },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://project.supabase.co/rest/v1/workspaces?select=id&limit=1",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/health",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("does not claim readiness when the database probe fails or encryption is invalid", async () => {
    clearReadinessEnvironment();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test_value");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test_value");
    vi.stubEnv("APP_ENCRYPTION_KEY", "too-short");
    vi.stubEnv("WORKER_SECRET", "mH7N2pQ9xT4vK8cR6zL3sW5yB1dF0gJa");
    vi.stubEnv("OPENAI_API_KEY", "provider-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      checks: { database: "unavailable", authentication: "unavailable", encryption: "invalid" },
    });
  });

  it("reports a configured but weak operational secret as invalid", async () => {
    clearReadinessEnvironment();
    vi.stubEnv("WORKER_SECRET", "worker-secret");
    vi.stubGlobal("fetch", vi.fn());

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      checks: { worker: "invalid" },
    });
  });
});
