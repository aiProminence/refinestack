import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const ownerEmail = process.env.E2E_OWNER_EMAIL;
const ownerPassword = process.env.E2E_OWNER_PASSWORD;
const fixtureRunId = process.env.E2E_RUN_ID;
const fixtureApiToken = process.env.E2E_API_TOKEN;

const roleCredentials = [
  ["owner", ownerEmail, ownerPassword],
  ["admin", process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD],
  ["analyst", process.env.E2E_ANALYST_EMAIL, process.env.E2E_ANALYST_PASSWORD],
  ["viewer", process.env.E2E_VIEWER_EMAIL, process.env.E2E_VIEWER_PASSWORD],
] as const;

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
  await expect(page.locator("#main-content")).toBeVisible();
}

test("credentialed owner traverses the connected setup-to-evidence-to-run-to-analytics journey", async ({ page, request }) => {
  test.skip(!ownerEmail || !ownerPassword || !fixtureRunId || !fixtureApiToken, "Credentialed Release 1 fixture is required.");
  await signIn(page, ownerEmail!, ownerPassword!);

  for (const path of [
    "/dashboard/setup",
    "/dashboard/questions",
    "/dashboard/evidence",
    "/dashboard/runs/new",
    "/dashboard/questions/review",
    `/dashboard/runs/${fixtureRunId}`,
    "/dashboard/analytics",
    "/dashboard/actions",
    "/dashboard/operations",
    "/dashboard/usage",
    "/dashboard/team",
    "/dashboard/settings",
  ]) {
    await page.goto(path);
    await expect(page).not.toHaveURL(/\/login/u);
    await expect(page.locator("#main-content h1")).toBeVisible();
    const serious = (await new AxeBuilder({ page }).analyze()).violations
      .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""));
    expect(serious).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  }

  const exported = await request.get(`/api/v1/runs/${fixtureRunId}/export?format=json`, {
    headers: { Authorization: `Bearer ${fixtureApiToken}` },
  });
  expect(exported.status()).toBe(200);
  await expect(exported.json()).resolves.toMatchObject({ run: { id: fixtureRunId }, observations: expect.any(Array) });

  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login(?:\?|$)/u);
});

for (const [role, email, password] of roleCredentials) {
  test(`${role} fixture receives its authenticated workspace role without cross-role escalation`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Role matrix is exercised once; the owner journey covers every configured engine/device.");
    test.skip(!email || !password, `E2E_${role.toUpperCase()} credentials are required.`);
    await signIn(page, email!, password!);
    await expect(page.locator(".sidebar-foot")).toContainText(role);
    await page.goto("/dashboard/team");
    await expect(page).not.toHaveURL(/\/access-revoked/u);
    if (role === "viewer" || role === "analyst") {
      await expect(page.getByRole("heading", { name: "Member administration is restricted" })).toBeVisible();
    }
  });
}
