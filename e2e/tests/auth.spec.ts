import { test, expect } from "@playwright/test";
import { LoginPage } from "../page-objects/LoginPage";
import { DashboardPage } from "../page-objects/DashboardPage";

test.describe("Authentication Flow", () => {
  // Test without saved state to verify the actual login UI
  test.use({ storageState: { cookies: [], origins: [] } });

  test("Valid login as admin renders dashboard @smoke @auth", async ({ page }) => {
    const loginPage = new LoginPage(page);
    const dashboardPage = new DashboardPage(page);

    await loginPage.goto();
    // Using the same credentials from global.setup.ts
    await loginPage.login(
      process.env.E2E_ADMIN_EMAIL ?? "admin@intellisys.com",
      process.env.E2E_ADMIN_PASS ?? "Password@123"
    );

    await loginPage.expectRedirectedToDashboard();
    await dashboardPage.expectVisible();
  });

  test("Invalid credentials show error @smoke @auth", async ({ page }) => {
    const loginPage = new LoginPage(page);

    await loginPage.goto();
    await loginPage.login("wrong@example.com", "badpassword");

    await loginPage.expectErrorVisible();
    await expect(page).not.toHaveURL(/dashboard/);
  });

  test("Direct URL access without auth redirects to login @smoke @auth", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/.*login.*/);
  });
});
