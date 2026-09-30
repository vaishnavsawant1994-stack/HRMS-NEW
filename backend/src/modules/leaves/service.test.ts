import assert from "node:assert/strict";
import test from "node:test";
import { AttendanceStatus } from "@prisma/client";
import { toZonedTime } from "date-fns-tz";
import { AppError } from "../../utils/api.js";
import {
  buildApprovedLeaveAttendanceEntries,
  buildLeaveOverlapWhere,
  createLeaveRequestForEmployee,
  getMedicalProofDueAt,
  hasAttendanceConflict,
  requiresMedicalProof,
} from "./service.js";

function currentQuarterDate(day: number) {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function currentFinancialYear() {
  const now = new Date();
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
}

function createTestLeaveType(overrides: Partial<{
  code: string;
  name: string;
  defaultDaysPerYear: number;
  allocationMode: "YEARLY" | "QUARTERLY";
  quarterlyAllocationDays: number | null;
  carryForwardAllowed: boolean;
  carryForwardCap: number | null;
  requiresAttachmentAfterDays: number | null;
  deductFullQuotaOnApproval: boolean;
  maxUsagesPerYear: number | null;
  policyEffectiveFromYear: number | null;
}> = {}) {
  return {
    id: 1,
    code: "EL",
    name: "Earned Leave",
    defaultDaysPerYear: 15,
    allocationMode: "YEARLY" as const,
    quarterlyAllocationDays: null,
    carryForwardAllowed: false,
    carryForwardCap: null,
    requiresAttachmentAfterDays: null,
    deductFullQuotaOnApproval: false,
    maxUsagesPerYear: null,
    policyEffectiveFromYear: null,
    ...overrides,
  };
}

function createLeaveDeps(overrides: Partial<Parameters<typeof createLeaveRequestForEmployee>[1]> = {}) {
  return {
    findOverlap: async () => null,
    findLeaveType: async () => createTestLeaveType(),
    findLeaveBalance: async () => ({ remainingDays: 10, visibleDays: 10, carryForwardDays: 0 }),
    countExistingYearRequests: async () => 0,
    createLeaveRequest: async (payload: unknown) => payload,
    ...overrides,
  };
}

test("buildLeaveOverlapWhere includes pending and approved statuses", () => {
  const where = buildLeaveOverlapWhere(1, new Date("2026-03-20"), new Date("2026-03-22"));
  assert.deepEqual(where.status, { in: ["PENDING", "APPROVED"] });
  assert.equal(where.employeeId, 1);
});

test("requiresMedicalProof only applies to sick leave requests", () => {
  assert.equal(requiresMedicalProof("SL", 3), true);
  assert.equal(requiresMedicalProof("sl", 2), true);
  assert.equal(requiresMedicalProof("CL", 4), false);
});

test("getMedicalProofDueAt adds 24 hours (1 day)", () => {
  const dueAt = getMedicalProofDueAt(new Date("2026-04-10T09:00:00.000Z"));
  assert.equal(dueAt.toISOString(), "2026-04-11T09:00:00.000Z");
});

test("createLeaveRequestForEmployee rejects overlap", async () => {
  await assert.rejects(
    () =>
      createLeaveRequestForEmployee(
        {
          actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
          leaveTypeId: 1,
          startDate: "2026-03-20",
          endDate: "2026-03-21",
          startDayDuration: "FULL_DAY",
          endDayDuration: "FULL_DAY",
          reason: "Trip",
        },
        {
          findOverlap: async () => ({ id: 1 }),
          findLeaveType: async () => createTestLeaveType(),
          findLeaveBalance: async () => ({ remainingDays: 10, visibleDays: 10, carryForwardDays: 0 }),
          countExistingYearRequests: async () => 0,
          createLeaveRequest: async () => ({ id: 10 }),
        },
      ),
    (error: unknown) => error instanceof AppError && error.message === "You already have a leave request for one or more of these dates.",
  );
});

test("createLeaveRequestForEmployee converts excess days to unpaid leave", async () => {
  const created = await createLeaveRequestForEmployee(
    {
      actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
      leaveTypeId: 1,
      startDate: "2026-03-20",
      endDate: "2026-03-25",
      startDayDuration: "FULL_DAY",
      endDayDuration: "FULL_DAY",
      reason: "Trip",
    },
    createLeaveDeps({
      findLeaveBalance: async () => ({ remainingDays: 2, visibleDays: 2, carryForwardDays: 0 }),
    }),
  );

  assert.equal((created as { totalDays: number }).totalDays, 6);
  assert.equal((created as { paidDays: number }).paidDays, 2);
  assert.equal((created as { unpaidDays: number }).unpaidDays, 4);
  assert.equal((created as { isUnpaid: boolean }).isUnpaid, true);
});

test("createLeaveRequestForEmployee creates fully unpaid leave when no balance exists", async () => {
  const created = await createLeaveRequestForEmployee(
    {
      actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
      leaveTypeId: 1,
      startDate: "2026-03-20",
      endDate: "2026-03-21",
      startDayDuration: "FULL_DAY",
      endDayDuration: "FULL_DAY",
      reason: "Trip",
    },
    createLeaveDeps({
      findLeaveBalance: async () => null,
    }),
  );

  assert.equal((created as { paidDays: number }).paidDays, 0);
  assert.equal((created as { unpaidDays: number }).unpaidDays, 2);
  assert.equal((created as { isUnpaid: boolean }).isUnpaid, true);
});

test("createLeaveRequestForEmployee creates request when rules pass", async () => {
  const created = await createLeaveRequestForEmployee(
    {
      actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
      leaveTypeId: 1,
      startDate: "2026-03-20",
      endDate: "2026-03-21",
      startDayDuration: "FULL_DAY",
      endDayDuration: "FULL_DAY",
      reason: "Trip",
    },
    createLeaveDeps(),
  );

  assert.equal((created as { totalDays: number }).totalDays, 2);
  assert.equal((created as { paidDays: number }).paidDays, 2);
  assert.equal((created as { unpaidDays: number }).unpaidDays, 0);
  assert.equal((created as { isUnpaid: boolean }).isUnpaid, false);
});

test("createLeaveRequestForEmployee creates half-day leave for a single date", async () => {
  const created = await createLeaveRequestForEmployee(
    {
      actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
      leaveTypeId: 1,
      startDate: "2026-03-20",
      endDate: "2026-03-20",
      startDayDuration: "HALF_DAY",
      endDayDuration: "HALF_DAY",
      reason: "Doctor visit",
    },
    createLeaveDeps(),
  );

  assert.equal((created as { totalDays: number }).totalDays, 0.5);
  assert.equal((created as { paidDays: number }).paidDays, 0.5);
  assert.equal((created as { unpaidDays: number }).unpaidDays, 0);
});

test("createLeaveRequestForEmployee supports start and end day half leave for ranges", async () => {
  const created = await createLeaveRequestForEmployee(
    {
      actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
      leaveTypeId: 1,
      startDate: "2026-03-20",
      endDate: "2026-03-22",
      startDayDuration: "HALF_DAY",
      endDayDuration: "HALF_DAY",
      reason: "Doctor visit",
    },
    createLeaveDeps(),
  );

  assert.equal((created as { totalDays: number }).totalDays, 2);
});

test("createLeaveRequestForEmployee rejects mismatched single-date day durations", async () => {
  await assert.rejects(
    () =>
      createLeaveRequestForEmployee(
        {
          actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
          leaveTypeId: 1,
          startDate: "2026-03-20",
          endDate: "2026-03-20",
          startDayDuration: "FULL_DAY",
          endDayDuration: "HALF_DAY",
          reason: "Doctor visit",
        },
        createLeaveDeps(),
      ),
    (error: unknown) => error instanceof AppError && error.message === "For a single-day leave request, please choose the same duration for both start and end.",
  );
});

test("createLeaveRequestForEmployee excludes non-working days when calendar-aware", async () => {
  const created = await createLeaveRequestForEmployee(
    {
      actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
      leaveTypeId: 1,
      startDate: "2026-03-20",
      endDate: "2026-03-22",
      startDayDuration: "FULL_DAY",
      endDayDuration: "FULL_DAY",
      reason: "Trip",
    },
    createLeaveDeps({
      isWorkingDay: async (date) => ![0, 6].includes(toZonedTime(date, "Asia/Kolkata").getDay()),
    }),
  );

  assert.equal((created as { totalDays: number }).totalDays, 1);
});

test("buildApprovedLeaveAttendanceEntries maps single full-day leave to LEAVE", () => {
  const entries = buildApprovedLeaveAttendanceEntries({
    startDate: new Date("2026-03-20"),
    endDate: new Date("2026-03-20"),
    startDayDuration: "FULL_DAY",
    endDayDuration: "FULL_DAY",
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.status, AttendanceStatus.LEAVE);
});

test("buildApprovedLeaveAttendanceEntries maps range endpoints to HALF_DAY when needed", () => {
  const entries = buildApprovedLeaveAttendanceEntries({
    startDate: new Date("2026-03-20"),
    endDate: new Date("2026-03-22"),
    startDayDuration: "HALF_DAY",
    endDayDuration: "HALF_DAY",
  });

  assert.equal(entries.length, 3);
  assert.equal(entries[0]?.status, AttendanceStatus.HALF_DAY);
  assert.equal(entries[1]?.status, AttendanceStatus.LEAVE);
  assert.equal(entries[2]?.status, AttendanceStatus.HALF_DAY);
});

test("buildApprovedLeaveAttendanceEntries skips non-working dates when provided", () => {
  const entries = buildApprovedLeaveAttendanceEntries({
    startDate: new Date("2026-03-20"),
    endDate: new Date("2026-03-22"),
    startDayDuration: "FULL_DAY",
    endDayDuration: "FULL_DAY",
    isWorkingDay: (date) => ![0, 6].includes(toZonedTime(date, "Asia/Kolkata").getDay()),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.status, AttendanceStatus.LEAVE);
});

test("hasAttendanceConflict detects worked attendance", () => {
  assert.equal(hasAttendanceConflict({ workedMinutes: 10 }), true);
  assert.equal(hasAttendanceConflict({ checkInTime: new Date(), workedMinutes: 0 }), true);
  assert.equal(hasAttendanceConflict({ checkOutTime: new Date(), workedMinutes: 0 }), true);
  assert.equal(hasAttendanceConflict({ workedMinutes: 0 }), false);
  assert.equal(hasAttendanceConflict(null), false);
});

test("createLeaveRequestForEmployee limits quarterly leave to visible balance", async () => {
  const created = await createLeaveRequestForEmployee(
    {
      actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
      leaveTypeId: 1,
      startDate: currentQuarterDate(10),
      endDate: currentQuarterDate(12),
      startDayDuration: "FULL_DAY",
      endDayDuration: "FULL_DAY",
      reason: "Personal work",
    },
    createLeaveDeps({
      findLeaveType: async () =>
        createTestLeaveType({
          code: "CL",
          name: "Casual Leave",
          defaultDaysPerYear: 12,
          allocationMode: "QUARTERLY",
          quarterlyAllocationDays: 3,
          policyEffectiveFromYear: currentFinancialYear(),
        }),
      findLeaveBalance: async () => ({ remainingDays: 12, visibleDays: 1, carryForwardDays: 0 }),
    }),
  );

  assert.equal((created as { paidDays: number }).paidDays, 1);
  assert.equal((created as { unpaidDays: number }).unpaidDays, 2);
});

test("createLeaveRequestForEmployee marks long sick leave as medical-proof required", async () => {
  const created = await createLeaveRequestForEmployee(
    {
      actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
      leaveTypeId: 1,
      startDate: currentQuarterDate(10),
      endDate: currentQuarterDate(12),
      startDayDuration: "FULL_DAY",
      endDayDuration: "FULL_DAY",
      reason: "Medical rest",
    },
    createLeaveDeps({
      findLeaveType: async () =>
        createTestLeaveType({
          code: "SL",
          name: "Sick Leave",
          defaultDaysPerYear: 8,
          allocationMode: "QUARTERLY",
          quarterlyAllocationDays: 2,
          carryForwardAllowed: true,
          carryForwardCap: 15,
          requiresAttachmentAfterDays: 2,
          policyEffectiveFromYear: currentFinancialYear(),
        }),
      findLeaveBalance: async () => ({ remainingDays: 8, visibleDays: 8, carryForwardDays: 0 }),
    }),
  );

  assert.equal((created as { medicalProofRequired: boolean }).medicalProofRequired, true);
  assert.equal((created as { medicalProofStatus: string }).medicalProofStatus, "PENDING_UPLOAD");
  assert.ok((created as { medicalProofDueAt: Date | null }).medicalProofDueAt instanceof Date);
});

test("createLeaveRequestForEmployee requires proof for two-day sick leave", async () => {
  const created = await createLeaveRequestForEmployee(
    {
      actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
      leaveTypeId: 1,
      startDate: currentQuarterDate(10),
      endDate: currentQuarterDate(11),
      startDayDuration: "FULL_DAY",
      endDayDuration: "FULL_DAY",
      reason: "Medical rest",
    },
    createLeaveDeps({
      findLeaveType: async () =>
        createTestLeaveType({
          code: "SL",
          name: "Sick Leave",
          defaultDaysPerYear: 8,
          allocationMode: "QUARTERLY",
          quarterlyAllocationDays: 2,
          carryForwardAllowed: true,
          carryForwardCap: 15,
          requiresAttachmentAfterDays: 2,
          policyEffectiveFromYear: currentFinancialYear(),
        }),
      findLeaveBalance: async () => ({ remainingDays: 8, visibleDays: 8, carryForwardDays: 0 }),
    }),
  );

  assert.equal((created as { medicalProofRequired: boolean }).medicalProofRequired, true);
  assert.equal((created as { medicalProofStatus: string }).medicalProofStatus, "PENDING_UPLOAD");
});

test("createLeaveRequestForEmployee blocks repeated one-time yearly leave", async () => {
  await assert.rejects(
    () =>
      createLeaveRequestForEmployee(
        {
          actor: { id: 1, role: "EMPLOYEE", employeeId: 99, email: "user@test.com" },
          leaveTypeId: 1,
          startDate: "2026-05-10",
          endDate: "2026-05-12",
          startDayDuration: "FULL_DAY",
          endDayDuration: "FULL_DAY",
          reason: "Family event",
        },
        createLeaveDeps({
          findLeaveType: async () =>
            createTestLeaveType({
              code: "BL",
              name: "Bereavement Leave",
              defaultDaysPerYear: 5,
              deductFullQuotaOnApproval: true,
              maxUsagesPerYear: 1,
              policyEffectiveFromYear: 2026,
            }),
          findLeaveBalance: async () => ({ remainingDays: 5, visibleDays: 5, carryForwardDays: 0 }),
          countExistingYearRequests: async () => 1,
        }),
      ),
    (error: unknown) => error instanceof AppError && error.message === "Bereavement Leave can only be used once in a year.",
  );
});
