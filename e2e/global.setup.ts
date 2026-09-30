/**
 * global.setup.ts
 *
 * Runs once before the full test suite.
 * Logs in as each role via the API and saves the auth token to a JSON fixture.
 * E2E tests then load this fixture instead of logging in via the UI each time.
 */

import { request } from "@playwright/test";
import path from "path";
import fs from "fs";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000/api";
const AUTH_DIR = path.join(__dirname, ".auth");

// ─── Seed credentials (must exist in the test DB) ─────────────────────────────
const ROLES = [
  { role: "admin",    email: process.env.E2E_ADMIN_EMAIL    ?? "admin@intellisys.com",    password: process.env.E2E_ADMIN_PASS    ?? "Password@123" },
  { role: "hr",       email: process.env.E2E_HR_EMAIL       ?? "hr@intellisys.com",       password: process.env.E2E_HR_PASS       ?? "Password@123" },
  { role: "manager",  email: process.env.E2E_MANAGER_EMAIL  ?? "manager@intellisys.com",  password: process.env.E2E_MANAGER_PASS  ?? "Password@123" },
  { role: "employee", email: process.env.E2E_EMPLOYEE_EMAIL ?? "employee@intellisys.com", password: process.env.E2E_EMPLOYEE_PASS ?? "Password@123" },
] as const;

async function globalSetup() {
  // Ensure .auth directory exists
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const context = await request.newContext({ baseURL: API_URL });

  for (const { role, email, password } of ROLES) {
    const response = await context.post("/auth/login", {
      data: { email, password },
    });

    if (!response.ok()) {
      const body = await response.text();
      throw new Error(`[Setup] Login failed for role "${role}" (${email}): ${response.status()} — ${body}`);
    }

    const body = await response.json();
    const token: string = body.data?.token;

    if (!token) {
      throw new Error(`[Setup] No token returned for role "${role}"`);
    }

    // Save token to a JSON file that tests can import
    const authFile = path.join(AUTH_DIR, `${role}.json`);
    fs.writeFileSync(authFile, JSON.stringify({ token }, null, 2));
    console.log(`[Setup] ✓ Auth token saved for role: ${role}`);
  }

  await context.dispose();
}

export default globalSetup;
