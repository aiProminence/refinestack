import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(() => ({ admin: true })),
  runWorkerCycle: vi.fn(),
  workerRequestAuthorized: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/worker", () => ({
  runWorkerCycle: mocks.runWorkerCycle,
  workerRequestAuthorized: mocks.workerRequestAuthorized,
}));

import { GET, POST } from "@/app/api/internal/worker/route";

describe("internal worker route", () => {
  beforeEach(() => {
    mocks.createAdminClient.mockClear();
    mocks.runWorkerCycle.mockReset().mockResolvedValue({ leased: 0, succeeded: 0 });
    mocks.workerRequestAuthorized.mockReset().mockReturnValue(true);
  });

  it("runs GET cron maintenance with a bounded batch", async () => {
    const response = await GET(new Request("https://refinestack.test/api/internal/worker?limit=3", { headers: { authorization: "Bearer cron" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.runWorkerCycle).toHaveBeenCalledWith(expect.objectContaining({ client: { admin: true }, limit: 3, leaseSeconds: 300, workerId: expect.stringMatching(/^worker:/u) }));
  });

  it("accepts an empty POST body for a manual trigger", async () => {
    const response = await POST(new Request("https://refinestack.test/api/internal/worker", { method: "POST", headers: { authorization: "Bearer manual" } }));
    expect(response.status).toBe(200);
    expect(mocks.runWorkerCycle).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
  });

  it("rejects unauthorized requests before creating an admin client", async () => {
    mocks.workerRequestAuthorized.mockReturnValue(false);
    const response = await GET(new Request("https://refinestack.test/api/internal/worker"));
    expect(response.status).toBe(401);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.runWorkerCycle).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized manual batches", async () => {
    expect((await POST(new Request("https://refinestack.test/api/internal/worker", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await POST(new Request("https://refinestack.test/api/internal/worker", { method: "POST", body: JSON.stringify({ limit: 11 }) }))).status).toBe(400);
  });
});
