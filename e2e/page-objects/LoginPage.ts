/**
 * page-objects/LoginPage.ts
 * Encapsulates all selectors and actions for the Login page.
 */

import { type Page, type Locator, expect } from "@playwright/test";

export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput    = page.getByLabel(/email/i);
    this.passwordInput = page.locator('input[type="password"]');
    this.submitButton  = page.getByRole("button", { name: /sign in|log in|login/i });
    this.errorMessage  = page.getByRole("alert").or(page.locator(".error-message, .toast-error, [data-testid='error']")).first();
  }

  async goto() {
    await this.page.goto("/");
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async expectErrorVisible() {
    await expect(this.errorMessage).toBeVisible({ timeout: 5_000 });
  }

  async expectRedirectedToDashboard() {
    await expect(this.page).toHaveURL(/dashboard|home/, { timeout: 10_000 });
  }
}
