import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
}

async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

test("public routes, navigation, legal copy, and API documentation remain usable", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("See which brands AI recommends");
  await expect(page.getByRole("link", { name: /RefineStack home/i })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
  await page.getByRole("link", { name: "Security" }).click();
  await expect(page).toHaveURL(/\/security$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Trust is an inspectable system.");
  await expectNoSeriousAccessibilityViolations(page);

  for (const [path, heading] of [
    ["/privacy", "Customer evidence stays customer evidence."],
    ["/terms", "Use intelligence with judgement."],
    ["/api-docs", "Evidence workflows, with explicit boundaries."],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    await expectNoSeriousAccessibilityViolations(page);
  }

  await expect(page.getByText("Idempotency-Key", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("X-RefineStack-Signature", { exact: false })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("login exposes sign-in, recovery, and password-update modes without account enumeration", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 2, name: "Welcome back" })).toBeVisible();
  await expect(page.getByLabel("Work email")).toHaveAttribute("autocomplete", "email");
  await expect(page.getByLabel("Password")).toHaveAttribute("autocomplete", "current-password");
  await expectNoSeriousAccessibilityViolations(page);

  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/mode=forgot/);
  await expect(page.getByRole("heading", { level: 2, name: "Reset your password" })).toBeVisible();
  await expect(page.getByText("if the address has workspace access", { exact: false })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);

  await page.goto("/login?mode=update-password");
  await expect(page.getByRole("heading", { level: 2, name: "Choose a new password" })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute("minlength", "12");
  await expect(page.getByLabel("Confirm new password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await expectNoSeriousAccessibilityViolations(page);
});

test("private workspace routes require authentication and unknown pages are actionable", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByRole("heading", { level: 2, name: "Welcome back" })).toBeVisible();

  await page.goto("/this-route-does-not-exist");
  await expect(page.getByRole("heading", { level: 1, name: "This page is outside the map." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Return to RefineStack" })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test("security headers use per-request nonces and API boundaries return stable errors", async ({ page, request }) => {
  const first = await request.get("/");
  const second = await request.get("/");
  const firstCsp = first.headers()["content-security-policy"] ?? "";
  const secondCsp = second.headers()["content-security-policy"] ?? "";
  const firstNonce = firstCsp.match(/'nonce-([^']+)'/u)?.[1];
  const secondNonce = secondCsp.match(/'nonce-([^']+)'/u)?.[1];
  expect(firstNonce).toBeTruthy();
  expect(secondNonce).toBeTruthy();
  expect(firstNonce).not.toBe(secondNonce);
  expect(firstCsp).not.toContain("'unsafe-inline'");
  expect(firstCsp).toContain("'strict-dynamic'");
  expect(first.headers()["x-content-type-options"]).toBe("nosniff");
  expect(first.headers()["x-frame-options"]).toBe("DENY");
  expect(first.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");

  await page.goto("/");
  const scriptNonces = await page.locator("script").evaluateAll((scripts) => scripts.map((script) => script.nonce));
  expect(scriptNonces.length).toBeGreaterThan(0);
  expect(scriptNonces.every(Boolean)).toBe(true);
  expect(new Set(scriptNonces).size).toBe(1);

  const api = await request.get("/api/v1");
  expect(api.status()).toBe(401);
  expect(api.headers()["www-authenticate"]).toBe('Bearer realm="RefineStack API"');
  await expect(api.json()).resolves.toMatchObject({ error: { code: "invalid_access_token" } });

  const worker = await request.get("/api/internal/worker");
  expect(worker.status()).toBe(401);
  await expect(worker.json()).resolves.toEqual({ error: "Unauthorized" });

  const health = await request.get("/api/health");
  const body = await health.json();
  expect(health.status()).toBe(body.status === "ready" ? 200 : 503);
  expect(body.checks).toEqual(expect.objectContaining({ database: expect.any(String), authentication: expect.any(String), worker: expect.any(String), encryption: expect.any(String) }));
});

test("public and auth layouts reflow at 320px without document-level overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  for (const path of ["/", "/login", "/login?mode=forgot", "/login?mode=update-password", "/api-docs", "/privacy", "/security", "/terms"]) {
    await page.goto(path);
    await expectNoDocumentOverflow(page);
  }
});

test("keyboard focus and reduced-motion preferences remain visible and respected", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The keyboard sequence is asserted once in the desktop engine.");
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /RefineStack home/i })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Method" })).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  const transitionDuration = await page.getByRole("link", { name: "Request access" }).evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.001);
});
