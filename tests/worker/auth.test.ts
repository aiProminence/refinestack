import { describe, expect, it } from "vitest";
import { isStrongOperationalSecret, operationalSecretState, workerRequestAuthorized } from "@/lib/worker/auth";

describe("worker request authorization", () => {
  const workerSecret = "mH7N2pQ9xT4vK8cR6zL3sW5yB1dF0gJa";
  const cronSecret = "X4sJ8nV2rC7kP5mQ9bT1yD6wH3fL0zGa";
  const request = (authorization?: string) => new Request("https://refinestack.test/api/internal/worker", {
    headers: authorization ? { authorization } : {},
  });

  it("accepts either independently configured worker secret", () => {
    const env = { NODE_ENV: "test", WORKER_SECRET: workerSecret, CRON_SECRET: cronSecret } as NodeJS.ProcessEnv;
    expect(workerRequestAuthorized(request(`Bearer ${workerSecret}`), env)).toBe(true);
    expect(workerRequestAuthorized(request(`Bearer ${cronSecret}`), env)).toBe(true);
  });

  it("fails closed for absent, malformed, empty, or incorrect credentials", () => {
    const env = { NODE_ENV: "test", WORKER_SECRET: workerSecret, CRON_SECRET: cronSecret } as NodeJS.ProcessEnv;
    expect(workerRequestAuthorized(request(), env)).toBe(false);
    expect(workerRequestAuthorized(request(`Basic ${workerSecret}`), env)).toBe(false);
    expect(workerRequestAuthorized(request(`Bearer ${workerSecret} extra`), env)).toBe(false);
    expect(workerRequestAuthorized(request("Bearer wrong"), env)).toBe(false);
    expect(workerRequestAuthorized(request("Bearer anything"), { NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("rejects weak configured secrets and reports the same readiness state", () => {
    const weakValues = ["short-secret", "a".repeat(64), `adequate-length-but-contains-space ${"x".repeat(20)}`];
    for (const value of weakValues) {
      const env = { NODE_ENV: "test", WORKER_SECRET: value } as NodeJS.ProcessEnv;
      expect(isStrongOperationalSecret(value)).toBe(false);
      expect(operationalSecretState(env)).toBe("invalid");
      expect(workerRequestAuthorized(request(`Bearer ${value}`), env)).toBe(false);
    }
    expect(operationalSecretState({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe("unconfigured");
  });

  it("fails readiness if either configured authorization path is weak", () => {
    expect(operationalSecretState({ NODE_ENV: "test", WORKER_SECRET: workerSecret, CRON_SECRET: "weak" } as NodeJS.ProcessEnv)).toBe("invalid");
    expect(operationalSecretState({ NODE_ENV: "test", WORKER_SECRET: workerSecret } as NodeJS.ProcessEnv)).toBe("healthy");
  });
});
