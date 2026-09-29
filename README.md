# HRMS Lean V1

<!-- repository-profile:start -->
## Repository profile

**Purpose:** HRMS Lean V1 is a human-resources management application for departments, employee records, attendance, leave, payroll, and role-based dashboards.

**Core contents:** React frontend; Express API; Prisma and PostgreSQL; JWT authentication; backend/frontend/E2E workspaces; architecture, testing, deployment, and project-management documentation.

**Current status:** This is the broadest of the three related HRMS repositories in this account and includes build, lint, unit-test, API/E2E, deployment, and spreadsheet-sync tooling. It is described as an MVP; production readiness must be established by current test and deployment evidence.

**Repository relationship:** Before parallel development, compare this repository with `IntelliHRMS` and `IntelliHRM`, then record one canonical HRMS source of truth.

**Recommended next milestone:** Run the full verification suite on the current default-branch head, document the deployment environment, and consolidate or clearly label the related HRMS copies.
<!-- repository-profile:end -->

Lean, production-ready HRMS MVP built with:

- React
- Express
- Prisma
- PostgreSQL
- JWT authentication

## Project Structure

- `backend/` Express API, Prisma schema, seed script
- `frontend/` React app for HRMS workflows
- `docs/` architecture and planning documents

## Setup & Local Development

Follow these steps to get the project running locally:

### 1. Initial Installation
Install all dependencies for both frontend and backend using npm workspaces:
```powershell
npm install
```

### 2. Environment Configuration
Create `.env` files for both modules from their respective examples.

**Backend:** `backend/.env` (Update with **PostgreSQL URL**, `JWT_SECRET`, and VAPID keys)
**Frontend:** `frontend/.env` (Ensure `VITE_API_BASE_URL` points to your backend)

### 3. Database & Prisma Setup
Ensure your PostgreSQL server is running, then initialize the database:

```powershell
# Run migrations to create tables
npm --workspace backend run prisma:migrate

# Seed essential data (Roles, Departments, and Leave Types)
npm --workspace backend run prisma:seed
```

### 4. Running the Application
You can start both frontend and backend simultaneously from the root:

```powershell
# Start both in dev mode
npm run dev:backend
npm run dev:frontend
```
Alternatively, go into each directory and run `npm run dev`.

## Implemented Lean V1 Modules

- Auth: login, logout, current user
- Departments
- Employees
- Attendance
- Leave types, balances, requests, approval
- Payroll
- Role-based dashboards

## Notes

- Leave balances must exist for employees before leave approval can succeed.
- V1 uses role-based access in code and does not include refresh tokens, audit logs, or permissions.
- Payroll is intentionally simple in V1: one monthly record per employee.
