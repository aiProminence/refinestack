import { expect, test } from "@playwright/test";

test("production HTTP boundaries and security headers are internally consistent", async ({ request }) => {
  const first = await request.get("/");
  const second = await request.get("/");
  expect(first.status()).toBe(200);
  const firstCsp = first.headers()["content-security-policy"] ?? "";
  const secondCsp = second.headers()["content-security-policy"] ?? "";
  const firstNonce = firstCsp.match(/'nonce-([^']+)'/u)?.[1];
  const secondNonce = secondCsp.match(/'nonce-([^']+)'/u)?.[1];
  expect(firstNonce).toBeTruthy();
  expect(secondNonce).toBeTruthy();
  expect(firstNonce).not.toBe(secondNonce);
  expect(firstCsp).toContain("'strict-dynamic'");
  expect(firstCsp).not.toContain("'unsafe-inline'");
  expect(first.headers()["x-content-type-options"]).toBe("nosniff");
  expect(first.headers()["x-frame-options"]).toBe("DENY");
  expect(first.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  const html = await first.text();
  expect(html).toContain(`nonce="${firstNonce}"`);

  const apiDocs = await request.get("/api-docs");
  expect(apiDocs.status()).toBe(200);
  expect(await apiDocs.text()).not.toMatch(/\sstyle=/u);

  const api = await request.get("/api/v1");
  expect(api.status()).toBe(401);
  expect(api.headers()["www-authenticate"]).toBe('Bearer realm="RefineStack API"');
  await expect(api.json()).resolves.toMatchObject({ error: { code: "invalid_access_token" } });

  const cancellation = await request.post("/api/v1/runs/018f47d2-83c3-7b80-a855-69b9298ab2a8/cancel", {
    data: { reason: "Cancelled by the HTTP boundary test." },
  });
  expect(cancellation.status()).toBe(401);
  await expect(cancellation.json()).resolves.toMatchObject({ error: { code: "invalid_access_token" } });

  const worker = await request.get("/api/internal/worker");
  expect(worker.status()).toBe(401);
  await expect(worker.json()).resolves.toEqual({ error: "Unauthorized" });

  const health = await request.get("/api/health");
  const healthBody = await health.json();
  expect(health.status()).toBe(healthBody.status === "ready" ? 200 : 503);
  expect(healthBody.checks).toEqual(expect.objectContaining({
    database: expect.any(String),
    authentication: expect.any(String),
    worker: expect.any(String),
    encryption: expect.any(String),
  }));

  const missing = await request.get("/this-route-does-not-exist");
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain("This page is outside the map.");
});
