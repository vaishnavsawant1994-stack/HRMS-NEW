import { AttendanceRegularizationStatus, AttendanceStatus, LeaveStatus } from "@prisma/client";
import { Router } from "express";
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE } from "../../utils/dates.js";
import * as XLSX from "xlsx";
import { z } from "zod";
import { prisma } from "../../config/prisma.js";
import { authenticate, requireRoles } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { AppError, sendSuccess } from "../../utils/api.js";
import { endOfDay, startOfDay } from "../../utils/dates.js";
import { canTeamLeadAccessEmployee, getScopedEmployeeIdsForTeamLead, hasEmployeeCapability } from "../../utils/team-lead.js";
import { getCalendarDayStatus } from "../calendar/service.js";
import {
  buildAttendanceWhereForDate,
  buildApprovedLeaveWhereForAttendanceDate,
  calculateWorkedMinutes,
  combineAttendanceDateAndTime,
  finalizeAttendanceForDate,
  getApprovedLeaveAttendanceStatusForDate,
  getRegularizedAttendanceStatus,
  parseAttendanceDateInput,
  finalizeAttendanceStatus,
} from "./service.js";
import {
  calculateOvertimeDuration,
  isOvertimeEligible,
  getMonthlyOvertimeHours,
} from "./overtime-service.js";
import { queueAttendanceSync } from "../../services/googleSheets.service.js";

const router = Router();

// In-memory sets to serialize break starts and desktop event processing per employee ID.
// This completely prevents race conditions (concurrent double-clicks/posts) on active operations.
const activeBreakOperations = new Set<number>();
const activeDesktopEventOperations = new Set<number>();

const attendanceSchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  todaysUpdate: z.string().optional(),
});

const attendanceFinalizeSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const attendanceRegularizationCreateSchema = z.object({
  attendanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  proposedCheckInTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  proposedCheckOutTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  reason: z.string().trim().min(1),
});

const attendanceRegularizationReviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  rejectionReason: z.string().trim().optional(),
});

async function enrichAttendanceWithLeaveContext(
  records: Array<{
    id: number;
    employeeId: number;
    attendanceDate: Date;
    status: AttendanceStatus;
  }>,
) {
  if (!records.length) {
    return records;
  }

  const employeeIds = [...new Set(records.map((record) => record.employeeId))];
  const attendanceDates = records.map((record) => record.attendanceDate.getTime());
  const rangeStart = new Date(Math.min(...attendanceDates));
  const rangeEnd = new Date(Math.max(...attendanceDates));

  const leaveRequests = await prisma.leaveRequest.findMany({
    where: {
      employeeId: { in: employeeIds },
      status: LeaveStatus.APPROVED,
      startDate: { lte: endOfDay(rangeEnd) },
      endDate: { gte: startOfDay(rangeStart) },
    },
    include: {
      leaveType: {
        select: {
          code: true,
          name: true,
        },
      },
    },
  });

  return records.map((record) => {
    if (record.status !== AttendanceStatus.LEAVE && record.status !== AttendanceStatus.HALF_DAY) {
      return record;
    }

    const matchingLeave = leaveRequests.find((leaveRequest) => {
      if (leaveRequest.employeeId !== record.employeeId) {
        return false;
      }

      const derivedStatus = getApprovedLeaveAttendanceStatusForDate(leaveRequest, record.attendanceDate);
      return (
        derivedStatus === record.status &&
        startOfDay(record.attendanceDate) >= startOfDay(leaveRequest.startDate) &&
        startOfDay(record.attendanceDate) <= startOfDay(leaveRequest.endDate)
      );
    });

    return {
      ...record,
      leaveTypeCode: matchingLeave?.leaveType.code ?? null,
      leaveTypeName: matchingLeave?.leaveType.name ?? null,
    };
  });
}

async function getAttendanceTodayForEmployee(employeeId: number) {
  const today = startOfDay(new Date());
  let [attendanceTodayRecord, approvedLeaveToday] = await Promise.all([
    prisma.attendance.findFirst({
      where: {
        employeeId,
        attendanceDate: buildAttendanceWhereForDate(today),
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        ...buildApprovedLeaveWhereForAttendanceDate(today),
      },
      include: {
        leaveType: {
          select: {
            code: true,
            name: true,
          },
        },
      },
    }),
  ]);



  return (
    attendanceTodayRecord ??
    (approvedLeaveToday
      ? {
        id: 0,
        employeeId,
        attendanceDate: today,
        checkInTime: null,
        checkOutTime: null,
        workedMinutes: 0,
        status:
          getApprovedLeaveAttendanceStatusForDate(approvedLeaveToday, today) === AttendanceStatus.HALF_DAY
            ? AttendanceStatus.HALF_DAY
            : AttendanceStatus.LEAVE,
        leaveTypeCode: approvedLeaveToday.leaveType.code,
        leaveTypeName: approvedLeaveToday.leaveType.name,
        penaltyMinutes: 0,
        lateByMinutes: 0,
        isLate: false,
      }
      : null)
  );
}

router.use(authenticate);

router.get("/today", requireRoles("EMPLOYEE", "MANAGER", "HR", "ADMIN"), async (request, response, next) => {
  try {
    const employeeId = request.user?.employeeId;

    if (!employeeId) {
      throw new AppError("Employee context is required", 400);
    }

    const [attendanceToday, overtimeSession] = await Promise.all([
      getAttendanceTodayForEmployee(employeeId),
      prisma.overtimeSession.findUnique({
        where: {
          employeeId_date: {
            employeeId,
            date: startOfDay(new Date()),
          },
        },
      }),
    ]);

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { shift: true }
    });
    const standardShiftRequired = employee?.shift?.requiredMinutes ?? 540;
    const requiredMinutes = standardShiftRequired - (attendanceToday?.lateByMinutes || 0) + (attendanceToday?.penaltyMinutes || 0);
    const isOvertimeEligible = (attendanceToday?.checkOutTime && attendanceToday.workedMinutes >= requiredMinutes) ? true : false;

    return sendSuccess(response, "Today's attendance fetched successfully", {
      attendanceToday,
      overtimeSession,
      isOvertimeEligible,
      shift: employee?.shift ?? null,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/check-in", validate(attendanceSchema), async (request, response, next) => {
  try {
    const employeeId = request.body.employeeId ?? request.user?.employeeId;

    if (!employeeId) {
      throw new AppError("Employee context is required", 400);
    }

    const isPrivileged = ["ADMIN", "HR"].includes(request.user!.role);

    if (!isPrivileged && request.user?.employeeId !== employeeId) {
      throw new AppError("You are not authorized to mark attendance for this employee", 403);
    }

    const today = startOfDay(new Date());
    const existing = await prisma.attendance.findFirst({
      where: {
        employeeId,
        attendanceDate: buildAttendanceWhereForDate(today),
      },
      orderBy: { createdAt: "desc" },
    });

    const approvedLeaveToday = await prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        ...buildApprovedLeaveWhereForAttendanceDate(today),
      },
      select: {
        startDate: true,
        endDate: true,
        startDayDuration: true,
        endDayDuration: true,
      },
    });

    if (approvedLeaveToday) {
      const leaveStatus = getApprovedLeaveAttendanceStatusForDate(approvedLeaveToday, today);
      throw new AppError(
        leaveStatus === AttendanceStatus.HALF_DAY
          ? "Check-in is not available on approved half-day leave yet"
          : "You are already marked on approved leave for today",
      );
    }

    if (existing?.status === AttendanceStatus.LEAVE) {
      throw new AppError("You are already marked on approved leave for today");
    }

    if (existing?.status === AttendanceStatus.ABSENT) {
      throw new AppError("Attendance for today is finalized as absent. Please request a correction.");
    }

    if (existing?.checkInTime) {
      throw new AppError(existing.checkOutTime ? "Attendance already completed for today" : "Attendance already checked in for today");
    }

    const checkInTime = new Date();

    // --- Late Penalty Logic ---
    // Shift timings are dynamic based on the employee's assigned shift
    const TIMEZONE = 'Asia/Kolkata';
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { shift: true },
    });

    if (!employee) {
      throw new AppError("Employee not found", 404);
    }

    const shift = employee.shift;
    const shiftStartTimeStr = shift?.startTime || "09:00";
    const [startHour, startMinute] = shiftStartTimeStr.split(":").map(Number);
    const gracePeriod = shift?.gracePeriodMinutes ?? 5;

    const shiftStartTime = toZonedTime(checkInTime, TIMEZONE);
    shiftStartTime.setHours(startHour, startMinute, 0, 0);
    const shiftStartInUTC = fromZonedTime(shiftStartTime, TIMEZONE);

    const lateByMinutes = checkInTime > shiftStartInUTC
      ? Math.floor((checkInTime.getTime() - shiftStartInUTC.getTime()) / 60000)
      : 0;

    let penaltyPoints = 0;
    let penaltyMinutes = 0;
    let isHalfDayPenalty = false;

    if (lateByMinutes >= 60) {
      isHalfDayPenalty = true;
      const additionalHours = Math.floor((lateByMinutes - 60) / 60);
      penaltyPoints = 10 + (additionalHours * 10);
      penaltyPoints = Math.min(penaltyPoints, 40); // Cap at 40 points max
      penaltyMinutes = 0; 
    } else if (lateByMinutes >= 30) {
      penaltyPoints = 10;
      penaltyMinutes = 60;
    } else if (lateByMinutes >= 15) {
      penaltyPoints = 5;
      penaltyMinutes = 45;
    } else if (lateByMinutes >= 10) {
      penaltyPoints = 2;
      penaltyMinutes = 30;
    } else if (lateByMinutes >= 6) {
      penaltyPoints = 1;
      penaltyMinutes = 20;
    } else if (lateByMinutes > 0) {
      penaltyPoints = 1;
      penaltyMinutes = 0;
    }

    const isLate = lateByMinutes > 0;
    // -------------------------

    const attendance = existing
      ? await prisma.attendance.update({
        where: { id: existing.id },
        data: {
          checkInTime,
          status: isHalfDayPenalty ? AttendanceStatus.HALF_DAY : AttendanceStatus.PRESENT,
          isLate,
          lateByMinutes,
          penaltyMinutes,
        },
      })
      : await prisma.attendance.create({
        data: {
          employeeId,
          attendanceDate: today,
          checkInTime,
          status: isHalfDayPenalty ? AttendanceStatus.HALF_DAY : AttendanceStatus.PRESENT,
          isLate,
          lateByMinutes,
          penaltyMinutes,
        },
      });

    // --- Apply Point Deduction ---
    if (penaltyPoints > 0) {
      const currentEmployee = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { points: true, userId: true }
      });
      
      if (currentEmployee) {
        const newPoints = currentEmployee.points - penaltyPoints;
        await prisma.employee.update({
          where: { id: employeeId },
          data: { points: newPoints }
        });
        
        await prisma.pointHistory.create({
          data: {
            employeeId,
            amount: penaltyPoints,
            reason: `Late check-in by ${lateByMinutes} minutes`,
            mode: "subtract",
          }
        });
        
        const { createNotification } = await import("../notifications/service.js");
        await createNotification({
          userId: currentEmployee.userId,
          title: "Late Check-in Penalty",
          message: `${penaltyPoints} points deducted and ${penaltyMinutes ? penaltyMinutes + 'm extra shift time added' : 'half-day applied'} for late check-in.`,
          type: "POINTS_UPDATE",
          link: "/team/leaderboard",
          sendPush: true,
        });
      }
    }
    // -------------------------

    await queueAttendanceSync(attendance.id);

    return sendSuccess(response, "Attendance checked in successfully", attendance, 201);

  } catch (error) {
    next(error);
  }
});

router.post("/check-out", validate(attendanceSchema), async (request, response, next) => {
  try {
    const employeeId = request.body.employeeId ?? request.user?.employeeId;

    if (!employeeId) {
      throw new AppError("Employee context is required", 400);
    }

    const isPrivileged = ["ADMIN", "HR"].includes(request.user!.role);

    if (!isPrivileged && request.user?.employeeId !== employeeId) {
      throw new AppError("You are not authorized to mark attendance for this employee", 403);
    }

    const today = startOfDay(new Date());
    const attendance = await prisma.attendance.findFirst({
      where: {
        employeeId,
        attendanceDate: buildAttendanceWhereForDate(today),
      },
      orderBy: { createdAt: "desc" },
    });

    if (!attendance?.checkInTime) {
      throw new AppError("Check-in not found for today");
    }

    if (attendance.checkOutTime) {
      throw new AppError("Attendance already checked out for today");
    }

    const checkOutTime = new Date();
    const grossMins = Math.floor((checkOutTime.getTime() - attendance.checkInTime.getTime()) / (1000 * 60));
    
    // Deduct completed breaks
    const breakSessions = await prisma.breakSession.findMany({
      where: { attendanceId: attendance.id, endTime: { not: null } },
    });
    const totalBreakMinutes = breakSessions.reduce((sum, session) => sum + (session.durationMinutes || 0), 0);
    const workedMinutes = Math.max(0, grossMins - totalBreakMinutes);

    const updatedAttendance = await prisma.attendance.update({
      where: { id: attendance.id },
      data: {
        checkOutTime,
        workedMinutes,
        todaysUpdate: request.body.todaysUpdate,
        status: finalizeAttendanceStatus(attendance.checkInTime, checkOutTime),
      },
    });

    await queueAttendanceSync(updatedAttendance.id);

    return sendSuccess(response, "Attendance checked out successfully", updatedAttendance);
  } catch (error) {
    next(error);
  }
});

// ── Break Session Routes ──────────────────────────────

router.get("/break/today", async (request, response, next) => {
  try {
    const employeeId = request.user?.employeeId;
    if (!employeeId) throw new AppError("Employee context is required", 400);

    const today = startOfDay(new Date());
    const attendance = await prisma.attendance.findFirst({
      where: { employeeId, attendanceDate: buildAttendanceWhereForDate(today) },
      orderBy: { createdAt: "desc" },
    });

    if (!attendance) {
      return sendSuccess(response, "No attendance record for today", { breakSessions: [] });
    }

    const breakSessions = await prisma.breakSession.findMany({
      where: { attendanceId: attendance.id },
      orderBy: { startTime: "asc" },
    });

    return sendSuccess(response, "Break sessions fetched", { breakSessions });
  } catch (error) {
    next(error);
  }
});

router.post("/break/start", async (request, response, next) => {
  const employeeId = request.user?.employeeId;
  if (!employeeId) throw new AppError("Employee context is required", 400);

  if (activeBreakOperations.has(employeeId)) {
    return next(new AppError("A break request is already being processed. Please wait.", 429));
  }
  activeBreakOperations.add(employeeId);

  try {
    const today = startOfDay(new Date());
    const attendance = await prisma.attendance.findFirst({
      where: { employeeId, attendanceDate: buildAttendanceWhereForDate(today) },
      orderBy: { createdAt: "desc" },
    });

    if (!attendance?.checkInTime) throw new AppError("You must be checked in before starting a break");
    if (attendance.checkOutTime) throw new AppError("Your shift has already ended");

    // Fetch employee shift to check if breaks are allowed
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { shift: true },
    });
    const hasBreaks = employee?.shift ? employee.shift.hasBreaks : true;
    if (!hasBreaks) {
      throw new AppError("Breaks are not allowed for your assigned shift", 400);
    }

    const openBreak = await prisma.breakSession.findFirst({
      where: { attendanceId: attendance.id, endTime: null },
    });
    if (openBreak) throw new AppError("A break is already in progress");

    // Guard against concurrent rapid double-clicks or duplicates
    const recentBreak = await prisma.breakSession.findFirst({
      where: {
        employeeId,
        startTime: {
          gte: new Date(Date.now() - 5000)
        }
      }
    });
    if (recentBreak) {
      return sendSuccess(response, "Break already started recently", recentBreak, 200);
    }

    const breakSession = await prisma.breakSession.create({
      data: { attendanceId: attendance.id, employeeId, startTime: new Date() },
    });

    return sendSuccess(response, "Break started", breakSession, 201);
  } catch (error) {
    next(error);
  } finally {
    activeBreakOperations.delete(employeeId);
  }
});

router.post("/break/end", async (request, response, next) => {
  try {
    const employeeId = request.user?.employeeId;
    if (!employeeId) throw new AppError("Employee context is required", 400);

    const today = startOfDay(new Date());
    const attendance = await prisma.attendance.findFirst({
      where: { employeeId, attendanceDate: buildAttendanceWhereForDate(today) },
      orderBy: { createdAt: "desc" },
    });

    if (!attendance) throw new AppError("No attendance record found for today");

    const openBreak = await prisma.breakSession.findFirst({
      where: { attendanceId: attendance.id, endTime: null },
      orderBy: { startTime: "desc" },
    });

    if (!openBreak) throw new AppError("No active break session found");

    const endTime = new Date();
    const durationMinutes = Math.floor((endTime.getTime() - openBreak.startTime.getTime()) / 60000);

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { shift: true },
    });

    const shift = employee?.shift;
    const hasBreaks = shift ? shift.hasBreaks : true;

    const shiftStartTime = shift?.startTime || "09:00";
    const shiftStartHour = parseInt(shiftStartTime.split(":")[0], 10);
    const isMorningShift = !isNaN(shiftStartHour) && shiftStartHour < 12;

    const parseTimeToMinutes = (timeStr: string): number => {
      const [h, m] = (timeStr || "").split(":").map(Number);
      return (isNaN(h) || isNaN(m)) ? 0 : h * 60 + m;
    };

    // ── Quota-Based Flexible Break Windows ───────────────────────────────────
    // Wide windows allow breaks taken slightly early or late to be classified
    // as the official break. The quota defines penalty-free minutes.
    //   Morning Tea  : 09:30 – 12:00  (quota 15 min, min qualifying 10 min)
    //   Lunch        : 12:00 – 15:00  (quota 40 min, min qualifying 20 min)
    //   Evening Tea  : 15:00 – 18:00  (quota 20 min, min qualifying 10 min)
    //   Dinner       : 19:00 – 23:00  (quota 40 min, min qualifying 20 min)
    // ─────────────────────────────────────────────────────────────────────────
    const windowDefs = [
      {
        label: "Morning Tea Break",
        windowStart: parseTimeToMinutes("09:30"),
        windowEnd:   parseTimeToMinutes("12:00"),
        quota:       (shift ? shift.allowMorningTea : true) ? 15 : 0,
        minToQualify: 10,
      },
      {
        label: "Lunch",
        windowStart: parseTimeToMinutes("12:00"),
        windowEnd:   parseTimeToMinutes("15:00"),
        quota:       (isMorningShift && (shift ? shift.allowLunch : true)) ? 40 : 0,
        minToQualify: 20,
      },
      {
        label: "Evening Tea Break",
        windowStart: parseTimeToMinutes("15:00"),
        windowEnd:   parseTimeToMinutes("18:00"),
        quota:       (shift ? shift.allowEveningTea : true) ? 20 : 0,
        minToQualify: 10,
      },
      {
        label: "Dinner Break",
        windowStart: parseTimeToMinutes("19:00"),
        windowEnd:   parseTimeToMinutes("23:00"),
        quota:       (!isMorningShift && (shift ? shift.allowDinner : true)) ? 40 : 0,
        minToQualify: 20,
      },
    ];

    // Classify the current break's start time
    const bStart = toZonedTime(openBreak.startTime, TIMEZONE);
    const totalStartMins = bStart.getHours() * 60 + bStart.getMinutes();

    // Find which wide window this break falls in
    const matchedWindow = hasBreaks
      ? windowDefs.find(w => totalStartMins >= w.windowStart && totalStartMins < w.windowEnd)
      : undefined;

    let breakLabel = "Break";
    let allowedDuration = 0;
    let isOfficialBreak = false;

    if (matchedWindow && matchedWindow.quota > 0) {
      breakLabel = matchedWindow.label;

      // Fetch all completed breaks for today to check quota exhaustion
      const completedBreaksToday = await prisma.breakSession.findMany({
        where: {
          attendanceId: attendance.id,
          endTime: { not: null },
          id: { not: openBreak.id },
        },
        orderBy: { startTime: "asc" },
      });

      // Check if an official break in this window was already recorded today
      const alreadyHasOfficialBreak = completedBreaksToday.some(b => {
        const bStartZoned = toZonedTime(b.startTime, TIMEZONE);
        const bMins = bStartZoned.getHours() * 60 + bStartZoned.getMinutes();
        return (
          bMins >= matchedWindow.windowStart &&
          bMins < matchedWindow.windowEnd &&
          (b.durationMinutes ?? 0) >= matchedWindow.minToQualify
        );
      });

      if (alreadyHasOfficialBreak) {
        // Quota exhausted — treat as raw away time (no penalty minutes added;
        // the break duration is already subtracted from worked mins at checkout)
        allowedDuration = 0;
        isOfficialBreak = false;
      } else if (durationMinutes >= matchedWindow.minToQualify) {
        // Meets minimum — this is the official break
        allowedDuration = matchedWindow.quota;
        isOfficialBreak = true;
      } else {
        // Below minimum duration — not an official break
        allowedDuration = 0;
        isOfficialBreak = false;
      }
    }

    // ── Penalty Calculation ───────────────────────────────────────────────────
    // Official break overspend: exact 1-to-1 penalty minutes, no points, no half-day.
    // Raw away (non-official): already deducted from workedMinutes at checkout.
    // ─────────────────────────────────────────────────────────────────────────
    let penaltyMinutes = 0;
    let lateByMinutes = 0;

    if (isOfficialBreak && durationMinutes > allowedDuration) {
      lateByMinutes = durationMinutes - allowedDuration;
      penaltyMinutes = lateByMinutes; // 1-to-1 exact penalty
    }

    const updated = await prisma.$transaction(async (tx) => {
      // 1. Update breakSession
      const bs = await tx.breakSession.update({
        where: { id: openBreak.id },
        data: { endTime, durationMinutes },
      });

      // 2. Accumulate penaltyMinutes (no points deduction for break overspend)
      if (penaltyMinutes > 0) {
        await tx.attendance.update({
          where: { id: attendance.id },
          data: {
            penaltyMinutes: (attendance.penaltyMinutes ?? 0) + penaltyMinutes,
          },
        });
      }

      return bs;
    });

    return sendSuccess(response, "Break ended", {
      ...updated,
      breakLabel,
      isOfficialBreak,
      allowedDuration,
      durationMinutes,
      penaltyMinutes,
      lateByMinutes,
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/finalize",
  requireRoles("ADMIN", "HR"),
  validate(attendanceFinalizeSchema),
  async (request, response, next) => {
    try {
      const result = await finalizeAttendanceForDate(
        { date: request.body.date },
        {
          findActiveEmployees: async () =>
            prisma.employee.findMany({
              where: { isActive: true },
              select: {
                id: true,
                joiningDate: true,
              },
            }),
          findEmployeeIdsWithAttendance: async (attendanceDate) => {
            const records = await prisma.attendance.findMany({
              where: {
                attendanceDate: {
                  gte: startOfDay(attendanceDate),
                  lte: endOfDay(attendanceDate),
                },
              },
              select: { employeeId: true },
              distinct: ["employeeId"],
            });

            return records.map((record) => record.employeeId);
          },
          findEmployeeIdsWithApprovedLeave: async (attendanceDate) => {
            const records = await prisma.leaveRequest.findMany({
              where: buildApprovedLeaveWhereForAttendanceDate(attendanceDate),
              select: { employeeId: true },
              distinct: ["employeeId"],
            });

            return records.map((record) => record.employeeId);
          },
          createAbsentAttendances: async (entries) => {
            const result = await prisma.attendance.createMany({
              data: entries,
              skipDuplicates: true,
            });

            return result.count;
          },
          updateAttendanceWithMissingCheckout: async (attendanceDate, cutoffHour) => {
            const attendancesToUpdate = await prisma.attendance.findMany({
              where: {
                attendanceDate: {
                  gte: startOfDay(attendanceDate),
                  lte: endOfDay(attendanceDate),
                },
                checkInTime: { not: null },
                status: AttendanceStatus.PRESENT,
              },
            });

            let updatedCount = 0;
            for (const attendance of attendancesToUpdate) {
              const finalStatus = finalizeAttendanceStatus(
                attendance.checkInTime,
                attendance.checkOutTime
              );

              if (finalStatus !== attendance.status) {
                await prisma.attendance.update({
                  where: { id: attendance.id },
                  data: { status: finalStatus },
                });
                updatedCount++;
              }
            }

            return updatedCount;
          },
          isWorkingDay: async (attendanceDate) => {
            const exceptions = await prisma.calendarException.findMany({
              where: {
                date: {
                  gte: startOfDay(attendanceDate),
                  lte: endOfDay(attendanceDate),
                },
              },
            });

            return getCalendarDayStatus(attendanceDate, exceptions).isWorkingDay;
          },
        },
      );

      return sendSuccess(response, "Attendance finalized successfully", result);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/regularizations",
  requireRoles("ADMIN", "HR", "MANAGER", "EMPLOYEE"),
  validate(attendanceRegularizationCreateSchema),
  async (request, response, next) => {
    try {
      const employeeId = request.user?.employeeId;

      if (!employeeId) {
        throw new AppError("Employee context is required", 400);
      }

      const attendanceDate = parseAttendanceDateInput(request.body.attendanceDate);
      const today = startOfDay(new Date());

      if (attendanceDate > today) {
        throw new AppError("Attendance correction cannot be requested for a future date");
      }

      const proposedCheckInTime = combineAttendanceDateAndTime(attendanceDate, request.body.proposedCheckInTime);
      const proposedCheckOutTime = combineAttendanceDateAndTime(attendanceDate, request.body.proposedCheckOutTime);

      if (!proposedCheckInTime && !proposedCheckOutTime) {
        throw new AppError("Provide at least one proposed check-in or check-out time");
      }

      if (proposedCheckInTime && proposedCheckOutTime && proposedCheckOutTime <= proposedCheckInTime) {
        throw new AppError("Proposed check-out must be after proposed check-in");
      }

      const duplicatePendingRequest = await prisma.attendanceRegularizationRequest.findFirst({
        where: {
          employeeId,
          attendanceDate,
          status: AttendanceRegularizationStatus.PENDING,
        },
      });

      if (duplicatePendingRequest) {
        throw new AppError("A pending attendance correction request already exists for this date");
      }

      const conflictingApprovedLeave = await prisma.leaveRequest.findFirst({
        where: {
          employeeId,
          ...buildApprovedLeaveWhereForAttendanceDate(attendanceDate),
        },
      });

      if (conflictingApprovedLeave) {
        throw new AppError("Attendance correction is not allowed for a date covered by approved leave");
      }

      const regularizationRequest = await prisma.attendanceRegularizationRequest.create({
        data: {
          employeeId,
          attendanceDate,
          proposedCheckInTime,
          proposedCheckOutTime,
          reason: request.body.reason,
        },
        include: {
          employee: true,
          reviewedBy: true,
        },
      });

      if (regularizationRequest.employee.managerId) {
        const manager = await prisma.employee.findUnique({
          where: { id: regularizationRequest.employee.managerId },
          select: { userId: true }
        });
        if (manager) {
          import("./../notifications/service.js").then(ns => {
            ns.createNotification({
              userId: manager.userId,
              title: "Correction Request 🕒",
              message: `${regularizationRequest.employee.firstName} requested a correction for ${formatInTimeZone(regularizationRequest.attendanceDate, TIMEZONE, 'dd MMM yyyy')}.`,
              type: "ATTENDANCE_REGULARIZATION_REQUESTED",
              link: "/attendance/requests",
              sendPush: true
            }).catch(err => console.error("Failed to notify manager of regularization:", err));
          });
        }
      }

      return sendSuccess(response, "Attendance correction request submitted successfully", regularizationRequest, 201);
    } catch (error) {
      next(error);
    }
  },
);

router.get("/regularizations", requireRoles("ADMIN", "HR", "MANAGER", "EMPLOYEE"), async (request, response, next) => {
  try {
    let where: Record<string, unknown> = {};

    if (request.user?.role === "EMPLOYEE") {
      const employeeId = request.user.employeeId;

      if (!employeeId) {
        throw new AppError("Employee context is required", 400);
      }

      const isTeamLead = await hasEmployeeCapability(prisma, employeeId, "TEAM_LEAD");

      where = isTeamLead
        ? {
          OR: [{ employeeId }, { employeeId: { in: await getScopedEmployeeIdsForTeamLead(prisma, employeeId) } }],
        }
        : { employeeId };
    } else if (request.user?.role === "MANAGER" && request.user.employeeId) {
      where = {
        OR: [{ employeeId: request.user.employeeId }, { employee: { managerId: request.user.employeeId } }],
      };
    }

    const regularizationRequests = await prisma.attendanceRegularizationRequest.findMany({
      where,
      include: {
        employee: true,
        reviewedBy: true,
      },
      orderBy: [{ createdAt: "desc" }],
    });

    return sendSuccess(response, "Attendance correction requests fetched successfully", regularizationRequests);
  } catch (error) {
    next(error);
  }
});

router.post(
  "/regularizations/:id/review",
  requireRoles("ADMIN", "HR", "MANAGER"),
  validate(attendanceRegularizationReviewSchema),
  async (request, response, next) => {
    try {
      const requestId = Number(request.params.id);

      if (!Number.isInteger(requestId) || requestId <= 0) {
        throw new AppError("Invalid attendance correction request");
      }

      const regularizationRequest = await prisma.attendanceRegularizationRequest.findUnique({
        where: { id: requestId },
        include: {
          employee: true,
        },
      });

      if (!regularizationRequest) {
        throw new AppError("Attendance correction request not found", 404);
      }

      if (regularizationRequest.status !== AttendanceRegularizationStatus.PENDING) {
        throw new AppError("Only pending attendance correction requests can be reviewed");
      }

      if (
        request.user?.role === "MANAGER" &&
        (!request.user.employeeId ||
          regularizationRequest.employee.managerId !== request.user.employeeId ||
          regularizationRequest.employeeId === request.user.employeeId)
      ) {
        throw new AppError("You are not authorized to review this attendance correction request", 403);
      }

      // Reviewer authorization is already ensured by requireRoles and the managerId check above.
      // Team Leads (Employees) are no longer permitted to review regularization requests.

      if (request.body.status === "REJECTED" && !request.body.rejectionReason) {
        throw new AppError("Rejection reason is required");
      }

      if (request.body.status === "APPROVED") {
        const conflictingApprovedLeave = await prisma.leaveRequest.findFirst({
          where: {
            employeeId: regularizationRequest.employeeId,
            ...buildApprovedLeaveWhereForAttendanceDate(regularizationRequest.attendanceDate),
          },
        });

        if (conflictingApprovedLeave) {
          throw new AppError("Attendance correction cannot be approved for a date covered by approved leave");
        }

        const existingAttendance = await prisma.attendance.findUnique({
          where: {
            employeeId_attendanceDate: {
              employeeId: regularizationRequest.employeeId,
              attendanceDate: regularizationRequest.attendanceDate,
            },
          },
        });

        if (existingAttendance?.status === AttendanceStatus.LEAVE) {
          throw new AppError("Attendance correction cannot overwrite leave attendance");
        }

        const checkInTime = regularizationRequest.proposedCheckInTime ?? existingAttendance?.checkInTime;
        const checkOutTime = regularizationRequest.proposedCheckOutTime ?? existingAttendance?.checkOutTime;

        const status = getRegularizedAttendanceStatus(
          checkInTime,
          checkOutTime,
        );
        let workedMinutes = 0;
        if (checkInTime && checkOutTime) {
          const grossMins = Math.max(0, Math.floor((checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60)));
          const breakSessions = await prisma.breakSession.findMany({
            where: { attendanceId: existingAttendance?.id || 0, endTime: { not: null } },
          });
          const totalBreakMinutes = breakSessions.reduce((sum, session) => sum + (session.durationMinutes || 0), 0);
          workedMinutes = Math.max(0, grossMins - totalBreakMinutes);
        }

        const [updatedAttendance] = await prisma.$transaction([
          existingAttendance
            ? prisma.attendance.update({
              where: { id: existingAttendance.id },
              data: {
                checkInTime,
                checkOutTime,
                workedMinutes,
                status,
              },
            })
            : prisma.attendance.create({
              data: {
                employeeId: regularizationRequest.employeeId,
                attendanceDate: regularizationRequest.attendanceDate,
                checkInTime,
                checkOutTime,
                workedMinutes,
                status,
              },
            }),
          prisma.attendanceRegularizationRequest.update({
            where: { id: regularizationRequest.id },
            data: {
              status: AttendanceRegularizationStatus.APPROVED,
              reviewedById: request.user?.employeeId,
              reviewedAt: new Date(),
              rejectionReason: null,
            },
          }),
        ]);
        
        await queueAttendanceSync(updatedAttendance.id);
      } else {
        await prisma.attendanceRegularizationRequest.update({
          where: { id: regularizationRequest.id },
          data: {
            status: AttendanceRegularizationStatus.REJECTED,
            reviewedById: request.user?.employeeId,
            reviewedAt: new Date(),
            rejectionReason: request.body.rejectionReason,
          },
        });
      }

      const updatedRequest = await prisma.attendanceRegularizationRequest.findUnique({
        where: { id: regularizationRequest.id },
        include: {
          employee: true,
          reviewedBy: true,
        },
      });

      if (updatedRequest) {
        import("./../notifications/service.js").then(ns => {
          const isApproved = updatedRequest.status === "APPROVED";
          ns.createNotification({
            userId: updatedRequest.employee.userId,
            title: isApproved ? "Attendance Corrected! ✅" : "Correction Rejected ❌",
            message: isApproved
              ? `Your attendance correction for ${formatInTimeZone(updatedRequest.attendanceDate, TIMEZONE, 'dd MMM yyyy')} has been approved.`
              : `Your attendance correction for ${formatInTimeZone(updatedRequest.attendanceDate, TIMEZONE, 'dd MMM yyyy')} was rejected.`,
            type: isApproved ? "ATTENDANCE_CORRECTION_APPROVED" : "ATTENDANCE_CORRECTION_REJECTED",
            link: "/attendance/requests",
            sendPush: true
          }).catch(err => console.error("Failed to create attendance correction notification:", err));
        });
      }

      return sendSuccess(response, "Attendance correction request reviewed successfully", updatedRequest);
    } catch (error) {
      next(error);
    }
  },
);

router.post("/regularizations/:id/cancel", requireRoles("ADMIN", "HR", "MANAGER", "EMPLOYEE"), async (request, response, next) => {
  try {
    const requestId = Number(request.params.id);

    if (!Number.isInteger(requestId) || requestId <= 0) {
      throw new AppError("Invalid attendance correction request");
    }

    const regularizationRequest = await prisma.attendanceRegularizationRequest.findUnique({
      where: { id: requestId },
      include: {
        employee: true,
      },
    });

    if (!regularizationRequest) {
      throw new AppError("Attendance correction request not found", 404);
    }

    if (regularizationRequest.employeeId !== request.user?.employeeId) {
      throw new AppError("You are not authorized to cancel this attendance correction request", 403);
    }

    if (regularizationRequest.status !== AttendanceRegularizationStatus.PENDING) {
      throw new AppError("Only pending attendance correction requests can be cancelled");
    }

    const updatedRequest = await prisma.attendanceRegularizationRequest.update({
      where: { id: regularizationRequest.id },
      data: {
        status: AttendanceRegularizationStatus.CANCELLED,
      },
      include: {
        employee: true,
        reviewedBy: true,
      },
    });

    return sendSuccess(response, "Attendance correction request cancelled successfully", updatedRequest);
  } catch (error) {
    next(error);
  }
});

router.get("/", requireRoles("ADMIN", "HR", "MANAGER", "EMPLOYEE"), async (request, response, next) => {
  try {
    const requestedEmployeeId = request.query.employeeId ? Number(request.query.employeeId) : undefined;
    const requestedDate = request.query.date ? parseAttendanceDateInput(String(request.query.date)) : undefined;
    let where: Record<string, unknown> = {};

    if (request.user?.role === "EMPLOYEE") {
      if (!request.user.employeeId) {
        throw new AppError("Employee context is required", 400);
      }

      if (requestedEmployeeId) {
        if (requestedEmployeeId !== request.user.employeeId) {
          const canAccess = await canTeamLeadAccessEmployee(prisma, request.user.employeeId, requestedEmployeeId);

          if (!canAccess) {
            throw new AppError("You are not authorized to view this attendance", 403);
          }
        }
        where = { employeeId: requestedEmployeeId };
      } else {
        const isTeamLead = await hasEmployeeCapability(prisma, request.user.employeeId, "TEAM_LEAD");

        where = isTeamLead
          ? {
            OR: [{ employeeId: request.user.employeeId }, { employeeId: { in: await getScopedEmployeeIdsForTeamLead(prisma, request.user.employeeId) } }],
          }
          : { employeeId: request.user.employeeId };
      }
    } else if (request.user?.role === "MANAGER" && request.user.employeeId) {
      where = requestedEmployeeId
        ? requestedEmployeeId === request.user.employeeId
          ? { employeeId: requestedEmployeeId }
          : { employeeId: requestedEmployeeId, employee: { managerId: request.user.employeeId } }
        : { employee: { managerId: request.user.employeeId } };
    } else if (requestedEmployeeId) {
      where = { employeeId: requestedEmployeeId };
    }

    const requestedMonth = request.query.month ? Number(request.query.month) : undefined;
    const requestedYear = request.query.year ? Number(request.query.year) : undefined;

    if (requestedYear && requestedMonth) {
      const startOfMonthDate = new Date(requestedYear, requestedMonth - 1, 1);
      const endOfMonthDate = new Date(requestedYear, requestedMonth, 0);

      where = {
        ...where,
        attendanceDate: {
          gte: startOfDay(startOfMonthDate),
          lte: endOfDay(endOfMonthDate),
        },
      };
    } else if (requestedDate) {
      const dateRange = {
        gte: startOfDay(requestedDate),
        lte: endOfDay(requestedDate),
      };

      where = {
        ...where,
        attendanceDate: dateRange,
      };
    }

    const attendance = await prisma.attendance.findMany({
      where,
      include: {
        breakSessions: true,
        employee: {
          include: {
            shift: true,
            outlookEmails: {
              include: {
                client: true
              }
            }
          }
        },
      },
      orderBy: [{ attendanceDate: "desc" }, { createdAt: "desc" }],
    });

    const enrichedAttendance = await enrichAttendanceWithLeaveContext(attendance);

    // Fetch overtime sessions matching these attendance records
    const employeeIds = enrichedAttendance.map((a) => a.employeeId);
    const dates = enrichedAttendance.map((a) => a.attendanceDate);
    const overtimeSessions = await prisma.overtimeSession.findMany({
      where: {
        employeeId: { in: employeeIds },
        date: { in: dates },
      },
    });

    const attendanceWithOvertime = enrichedAttendance.map((record) => {
      const matchingOT = overtimeSessions.find((ot) =>
        ot.employeeId === record.employeeId &&
        startOfDay(ot.date).getTime() === startOfDay(record.attendanceDate).getTime()
      );
      return {
        ...record,
        overtimeSession: matchingOT
          ? {
              id: matchingOT.id,
              duration: matchingOT.duration,
              status: matchingOT.status,
              startTime: matchingOT.startTime,
              endTime: matchingOT.endTime,
            }
          : null,
      };
    });

    return sendSuccess(response, "Attendance records fetched successfully", attendanceWithOvertime);
  } catch (error) {
    next(error);
  }
});

// Overtime Routes
router.post(
  "/overtime/pre-approval",
  validate(z.object({ reason: z.string().trim().min(1, "Reason is required") })),
  async (request, response, next) => {
    try {
      const employeeId = request.user?.employeeId;
      if (!employeeId) {
        throw new AppError("Employee context is required", 400);
      }

      const today = startOfDay(new Date());

      // 1. Check if today is a working day
      const exceptions = await prisma.calendarException.findMany({
        where: {
          date: {
            gte: today,
            lte: endOfDay(new Date()),
          },
        },
      });
      const isWorking = getCalendarDayStatus(today, exceptions).isWorkingDay;
      if (!isWorking) {
        throw new AppError("Overtime pre-approval can only be requested on a working day", 400);
      }

      // 2. Check if submitted before 5:00 PM IST (Asia/Kolkata)
      const zonedNow = toZonedTime(new Date(), TIMEZONE);
      if (zonedNow.getHours() >= 17) {
        throw new AppError("Overtime pre-approval requests must be submitted before 5:00 PM", 400);
      }

      // 3. Check if employee has today's attendance record
      const attendance = await prisma.attendance.findFirst({
        where: {
          employeeId,
          attendanceDate: buildAttendanceWhereForDate(today),
        },
        orderBy: { createdAt: "desc" },
      });

      if (!attendance || !attendance.checkInTime) {
        throw new AppError("You must be checked in today to request overtime pre-approval", 400);
      }

      // 4. Check if an overtime session already exists for today
      const existingOvertime = await prisma.overtimeSession.findUnique({
        where: {
          employeeId_date: {
            employeeId,
            date: today,
          },
        },
      });

      if (existingOvertime) {
        throw new AppError("An overtime session or pre-approval request already exists for today", 400);
      }

      // 5. Create OvertimeSession record with status: "PENDING_VERIFICATION" and isPaid: true
      const overtimeSession = await prisma.overtimeSession.create({
        data: {
          employeeId,
          date: today,
          startTime: new Date(),
          isPaid: true,
          status: "PENDING_VERIFICATION",
          reason: request.body.reason,
        },
      });

      return sendSuccess(response, "Overtime pre-approval request submitted successfully", overtimeSession, 201);
    } catch (error) {
      next(error);
    }
  }
);

router.get("/overtime/today", requireRoles("EMPLOYEE", "MANAGER", "HR", "ADMIN"), async (request, response, next) => {
  try {
    const employeeId = request.user?.employeeId;

    if (!employeeId) {
      throw new AppError("Employee context is required", 400);
    }

    const today = startOfDay(new Date());
    const overtimeSession = await prisma.overtimeSession.findUnique({
      where: {
        employeeId_date: {
          employeeId,
          date: today,
        },
      },
    });

    return sendSuccess(response, "Today's overtime session fetched successfully", { overtimeSession });
  } catch (error) {
    next(error);
  }
});

router.post("/overtime/start", validate(attendanceSchema), async (request, response, next) => {
  try {
    const employeeId = request.body.employeeId ?? request.user?.employeeId;

    if (!employeeId) {
      throw new AppError("Employee context is required", 400);
    }

    const isPrivileged = ["ADMIN", "HR"].includes(request.user!.role);

    if (!isPrivileged && request.user?.employeeId !== employeeId) {
      throw new AppError("You are not authorized to start overtime for this employee", 403);
    }

    const today = startOfDay(new Date());

    // Check if regular attendance is completed
    const attendance = await prisma.attendance.findFirst({
      where: {
        employeeId,
        attendanceDate: buildAttendanceWhereForDate(today),
      },
      orderBy: { createdAt: "desc" },
    });

    if (!attendance?.checkOutTime) {
      throw new AppError("Regular attendance checkout is required before starting overtime");
    }

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { shift: true }
    });
    const standardShiftRequired = employee?.shift?.requiredMinutes ?? 540;
    const requiredMinutes = standardShiftRequired - (attendance.lateByMinutes || 0) + (attendance.penaltyMinutes || 0);
    if (attendance.workedMinutes < requiredMinutes) {
      throw new AppError(`You must complete at least ${(requiredMinutes / 60).toFixed(1)} hours of standard work today to be eligible for overtime`, 400);
    }

    // Check if overtime session already exists
    const existingOvertime = await prisma.overtimeSession.findUnique({
      where: {
        employeeId_date: {
          employeeId,
          date: today,
        },
      },
    });

    if (existingOvertime) {
      if (existingOvertime.status === "ACTIVE") {
        throw new AppError("Overtime session already in progress");
      } else if (existingOvertime.status === "APPROVED") {
        // Pre-approved: transition to ACTIVE and update startTime to now
        const overtimeSession = await prisma.overtimeSession.update({
          where: { id: existingOvertime.id },
          data: {
            status: "ACTIVE",
            startTime: new Date(),
          },
        });
        return sendSuccess(response, "Overtime started successfully", overtimeSession);
      } else if (existingOvertime.status === "PENDING_VERIFICATION" && existingOvertime.isPaid && !existingOvertime.endTime) {
        throw new AppError("Your paid overtime pre-approval request is still pending approval by a manager or HR", 400);
      } else if (existingOvertime.status === "REJECTED") {
        // Pre-approval was rejected: let them start regular overtime by overwriting the session to ACTIVE with isPaid = false
        const overtimeSession = await prisma.overtimeSession.update({
          where: { id: existingOvertime.id },
          data: {
            status: "ACTIVE",
            startTime: new Date(),
            isPaid: false,
            rejectionReason: null,
          },
        });
        return sendSuccess(response, "Overtime started successfully (Regular)", overtimeSession);
      } else {
        throw new AppError("Overtime session already completed for today");
      }
    }

    const overtimeSession = await prisma.overtimeSession.create({
      data: {
        employeeId,
        date: today,
        startTime: new Date(),
        status: "ACTIVE",
      },
    });

    return sendSuccess(response, "Overtime started successfully", overtimeSession, 201);
  } catch (error) {
    next(error);
  }
});

router.post("/overtime/end", validate(attendanceSchema), async (request, response, next) => {
  try {
    const employeeId = request.body.employeeId ?? request.user?.employeeId;

    if (!employeeId) {
      throw new AppError("Employee context is required", 400);
    }

    const isPrivileged = ["ADMIN", "HR"].includes(request.user!.role);

    if (!isPrivileged && request.user?.employeeId !== employeeId) {
      throw new AppError("You are not authorized to end overtime for this employee", 403);
    }

    const today = startOfDay(new Date());
    const overtimeSession = await prisma.overtimeSession.findUnique({
      where: {
        employeeId_date: {
          employeeId,
          date: today,
        },
      },
    });

    if (!overtimeSession) {
      throw new AppError("No active overtime session found");
    }

    if (overtimeSession.status !== "ACTIVE") {
      throw new AppError("Overtime session is not active");
    }

    const endTime = new Date();
    const duration = calculateOvertimeDuration(overtimeSession.startTime, endTime);

    const updatedSession = await prisma.overtimeSession.update({
      where: { id: overtimeSession.id },
      data: {
        endTime,
        duration,
        status: "COMPLETED",
      },
    });

    return sendSuccess(response, "Overtime ended successfully", updatedSession);
  } catch (error) {
    next(error);
  }
});

router.get("/overtime", requireRoles("ADMIN", "HR", "MANAGER", "EMPLOYEE"), async (request, response, next) => {
  try {
    const requestedEmployeeId = request.query.employeeId ? Number(request.query.employeeId) : undefined;
    const requestedMonth = request.query.month ? Number(request.query.month) : undefined;
    const requestedYear = request.query.year ? Number(request.query.year) : undefined;

    let where: Record<string, unknown> = {};

    if (request.user?.role === "EMPLOYEE") {
      if (!request.user.employeeId) {
        throw new AppError("Employee context is required", 400);
      }

      if (requestedEmployeeId) {
        if (requestedEmployeeId !== request.user.employeeId) {
          const canAccess = await canTeamLeadAccessEmployee(prisma, request.user.employeeId, requestedEmployeeId);

          if (!canAccess) {
            throw new AppError("You are not authorized to view this overtime", 403);
          }
        }
        where = { employeeId: requestedEmployeeId };
      } else {
        const isTeamLead = await hasEmployeeCapability(prisma, request.user.employeeId, "TEAM_LEAD");

        where = isTeamLead
          ? {
            OR: [{ employeeId: request.user.employeeId }, { employeeId: { in: await getScopedEmployeeIdsForTeamLead(prisma, request.user.employeeId) } }],
          }
          : { employeeId: request.user.employeeId };
      }
    } else if (request.user?.role === "MANAGER" && request.user.employeeId) {
      where = requestedEmployeeId
        ? requestedEmployeeId === request.user.employeeId
          ? { employeeId: requestedEmployeeId }
          : { employeeId: requestedEmployeeId, employee: { managerId: request.user.employeeId } }
        : { employee: { managerId: request.user.employeeId } };
    } else if (requestedEmployeeId) {
      where = { employeeId: requestedEmployeeId };
    }

    // Add month/year filter if provided
    if (requestedMonth && requestedYear) {
      const startDate = new Date(requestedYear, requestedMonth - 1, 1);
      const endDate = new Date(requestedYear, requestedMonth, 0);

      where = {
        ...where,
        date: {
          gte: startDate,
          lte: endDate,
        },
      };
    }

    const overtimeSessions = await prisma.overtimeSession.findMany({
      where,
      include: {
        employee: true,
        verifier: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });

    return sendSuccess(response, "Overtime sessions fetched successfully", overtimeSessions);
  } catch (error) {
    next(error);
  }
});

router.post(
  "/overtime/:id/verify",
  requireRoles("ADMIN", "HR", "MANAGER"),
  validate(z.object({
    status: z.enum(["VERIFIED", "REJECTED"]),
    rejectionReason: z.string().trim().optional(),
  })),
  async (request, response, next) => {
    try {
      const sessionId = Number(request.params.id);

      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        throw new AppError("Invalid overtime session");
      }

      const overtimeSession = await prisma.overtimeSession.findUnique({
        where: { id: sessionId },
        include: {
          employee: true,
        },
      });

      if (!overtimeSession) {
        throw new AppError("Overtime session not found", 404);
      }

      const isPreApprovalRequest = overtimeSession.isPaid && !overtimeSession.endTime;

      if (!isPreApprovalRequest && overtimeSession.status !== "COMPLETED") {
        throw new AppError("Only completed overtime sessions can be verified");
      }

      if (
        request.user?.role === "MANAGER" &&
        (!request.user.employeeId ||
          overtimeSession.employee.managerId !== request.user.employeeId)
      ) {
        throw new AppError("You are not authorized to verify this overtime session", 403);
      }

      if (request.body.status === "REJECTED" && !request.body.rejectionReason) {
        throw new AppError("Rejection reason is required");
      }

      let targetStatus = request.body.status;
      if (isPreApprovalRequest && targetStatus === "VERIFIED") {
        targetStatus = "APPROVED";
      }

      const updatedSession = await prisma.overtimeSession.update({
        where: { id: sessionId },
        data: {
          status: targetStatus,
          verifiedBy: request.user?.employeeId,
          verifiedAt: new Date(),
          rejectionReason: request.body.status === "REJECTED" ? request.body.rejectionReason : null,
        },
        include: {
          employee: true,
          verifier: true,
        },
      });

      return sendSuccess(response, "Overtime session verified successfully", updatedSession);
    } catch (error) {
      next(error);
    }
  },
);

// ── Leaderboard / Employee of the Month ──────────────────────────────────────
// GET /attendance/leaderboard?month=5&year=2026
// Returns work-hours ranking + on-time check-in ranking for the manager's team.
router.get(
  "/leaderboard",
  requireRoles("MANAGER", "ADMIN", "HR", "EMPLOYEE"),
  async (request, response, next) => {
    try {
      const now = new Date();
      const month = request.query.month ? Number(request.query.month) : now.getMonth() + 1;
      const year  = request.query.year  ? Number(request.query.year)  : now.getFullYear();

      const startDate = new Date(year, month - 1, 1);
      const endDate   = new Date(year, month, 0, 23, 59, 59, 999);

      // Determine scope: Everyone sees the entire leaderboard
      const employeeWhere: Record<string, unknown> = { isActive: true };

      // Fetch all attendance records for the month for the relevant employees
      const attendanceRecords = await prisma.attendance.findMany({
        where: {
          attendanceDate: { gte: startDate, lte: endDate },
          employee: employeeWhere,
        },
        include: {
          employee: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              employeeCode: true,
              jobTitle: true,
              points: true,
              profilePictureUrl: true,
              department: { select: { name: true } },
            },
          },
        },
      });

      // --- Work hours ranking ---
      const workMap = new Map<number, { employee: any; totalMinutes: number; presentDays: number }>();
      for (const rec of attendanceRecords) {
        if (!workMap.has(rec.employeeId)) {
          workMap.set(rec.employeeId, { employee: rec.employee, totalMinutes: 0, presentDays: 0 });
        }
        const entry = workMap.get(rec.employeeId)!;
        entry.totalMinutes += rec.workedMinutes ?? 0;
        if (rec.status === "PRESENT" || rec.status === "HALF_DAY") entry.presentDays += 1;
      }

      const workHoursRanking = Array.from(workMap.values())
        .sort((a, b) => b.totalMinutes - a.totalMinutes)
        .map((entry, index) => ({
          rank: index + 1,
          employee: entry.employee,
          totalMinutes: entry.totalMinutes,
          totalHours: +(entry.totalMinutes / 60).toFixed(1),
          presentDays: entry.presentDays,
        }));

      // --- On-time check-in ranking ---
      const onTimeMap = new Map<number, { employee: any; onTimeDays: number; lateDays: number; totalDays: number }>();
      for (const rec of attendanceRecords) {
        if (rec.status !== "PRESENT" && rec.status !== "HALF_DAY") continue;
        if (!onTimeMap.has(rec.employeeId)) {
          onTimeMap.set(rec.employeeId, { employee: rec.employee, onTimeDays: 0, lateDays: 0, totalDays: 0 });
        }
        const entry = onTimeMap.get(rec.employeeId)!;
        entry.totalDays += 1;
        if (rec.isLate) entry.lateDays += 1;
        else entry.onTimeDays += 1;
      }

      const onTimeRanking = Array.from(onTimeMap.values())
        .filter(e => e.totalDays > 0)
        .sort((a, b) => {
          const aRate = a.onTimeDays / a.totalDays;
          const bRate = b.onTimeDays / b.totalDays;
          if (bRate !== aRate) return bRate - aRate;
          return b.onTimeDays - a.onTimeDays;
        })
        .map((entry, index) => ({
          rank: index + 1,
          employee: entry.employee,
          onTimeDays: entry.onTimeDays,
          lateDays: entry.lateDays,
          totalDays: entry.totalDays,
          onTimeRate: entry.totalDays > 0 ? +(entry.onTimeDays / entry.totalDays * 100).toFixed(1) : 0,
        }));

      const employeeOfMonth = workHoursRanking[0] ?? null;

      // --- Points ranking ---
      const activeEmployees = await prisma.employee.findMany({
        where: { isActive: true },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeCode: true,
          jobTitle: true,
          points: true,
          profilePictureUrl: true,
          department: { select: { name: true } },
        },
        orderBy: { points: 'desc' }
      });

      const pointsRanking = activeEmployees.map((emp, index) => ({
        rank: index + 1,
        employee: emp,
        points: emp.points,
      }));

      return sendSuccess(response, "Leaderboard fetched successfully", {
        month,
        year,
        employeeOfMonth,
        workHoursRanking,
        onTimeRanking,
        pointsRanking,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/live-status", requireRoles("ADMIN", "HR", "MANAGER", "EMPLOYEE"), async (request, response, next) => {
  try {
    const today = startOfDay(new Date());

    const employees = await prisma.employee.findMany({
      where: { isActive: true },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        employeeCode: true,
        lastDesktopActive: true,
        user: {
          select: {
            email: true,
          },
        },
        attendances: {
          where: {
            attendanceDate: buildAttendanceWhereForDate(today),
          },
          select: {
            checkInTime: true,
            checkOutTime: true,
            breakSessions: {
              where: { endTime: null },
              take: 1,
            },
          },
        },
        desktopActivityLogs: {
          where: {
            timestamp: {
              gte: today,
            },
          },
          orderBy: { timestamp: "desc" },
          take: 1,
        },
      },
    });

    const liveStatuses = employees.map((emp) => {
      const todayAttendance = emp.attendances[0] ?? null;
      const lastLog = emp.desktopActivityLogs[0] ?? null;

      const checkInTimeDate = todayAttendance?.checkInTime ? new Date(todayAttendance.checkInTime) : null;
      const checkOutTimeDate = todayAttendance?.checkOutTime ? new Date(todayAttendance.checkOutTime) : null;
      
      // Only consider logs that occurred during/after the current check-in (and before check-out if checked out)
      const isLogDuringWorkday = lastLog && checkInTimeDate && (
        new Date(lastLog.timestamp).getTime() >= checkInTimeDate.getTime()
      ) && (
        !checkOutTimeDate || new Date(lastLog.timestamp).getTime() <= checkOutTimeDate.getTime()
      );

      const effectiveLastLog = isLogDuringWorkday ? lastLog : null;

      let status: "ACTIVE" | "AWAY" | "OFFLINE" = "OFFLINE";
      let lastEvent: string | null = null;
      let lastEventTime: Date | null = null;

      if (effectiveLastLog) {
        lastEvent = effectiveLastLog.eventType;
        lastEventTime = effectiveLastLog.timestamp;
      }

      if (todayAttendance) {
        const hasActiveBreak = todayAttendance.breakSessions && todayAttendance.breakSessions.length > 0;
        if (todayAttendance.checkOutTime) {
          status = "OFFLINE";
        } else if (todayAttendance.checkInTime) {
          if (hasActiveBreak || (effectiveLastLog && ["LOCK", "SLEEP", "IDLE_START"].includes(effectiveLastLog.eventType))) {
            status = "AWAY";
          } else {
            status = "ACTIVE";
          }
        }
      }

      return {
        employeeId: emp.id,
        firstName: emp.firstName,
        lastName: emp.lastName,
        employeeCode: emp.employeeCode,
        email: emp.user.email,
        status,
        lastEvent,
        lastEventTime,
        checkInTime: todayAttendance?.checkInTime ?? null,
        checkOutTime: todayAttendance?.checkOutTime ?? null,
        lastDesktopActive: emp.lastDesktopActive,
      };
    });

    return sendSuccess(response, "Live statuses fetched successfully", liveStatuses);
  } catch (error) {
    next(error);
  }
});

const desktopEventSchema = z.object({
  eventType: z.enum(["LOCK", "UNLOCK", "SLEEP", "WAKE", "SHUTDOWN", "IDLE_START", "IDLE_END"]).optional(),
  timestamp: z.string().optional(),
  EventType: z.enum(["LOCK", "UNLOCK", "SLEEP", "WAKE", "SHUTDOWN", "IDLE_START", "IDLE_END"]).optional(),
  Timestamp: z.string().optional(),
});

router.post(
  "/desktop-event",
  validate(desktopEventSchema),
  async (request, response, next) => {
    const employeeId = request.user?.employeeId;

    if (!employeeId) {
      throw new AppError("Employee profile not found for this user context", 404);
    }

    if (activeDesktopEventOperations.has(employeeId)) {
      return next(new AppError("A desktop event is already being processed. Please wait.", 429));
    }
    activeDesktopEventOperations.add(employeeId);

    try {
      const eventType = request.body.eventType || request.body.EventType;
      const timestamp = request.body.timestamp || request.body.Timestamp;

      if (!eventType || !timestamp) {
        throw new AppError("Both eventType (or EventType) and timestamp (or Timestamp) are required", 400);
      }

      const parsedTime = new Date(timestamp);

      // Check for duplicate desktop activity log to prevent multiple database logs or redundant break triggers
      const existingLog = await prisma.desktopActivityLog.findFirst({
        where: {
          employeeId,
          eventType,
          timestamp: parsedTime,
        },
      });

      if (existingLog) {
        return sendSuccess(response, "Desktop event already logged", {
          logged: false,
          alreadyLogged: true,
          attendanceActive: true,
        });
      }

      // 1. Log the desktop event
      await prisma.desktopActivityLog.create({
        data: {
          employeeId,
          eventType,
          timestamp: parsedTime,
          ipAddress: request.ip || null,
        },
      });

      // Find the attendance record for the date of the event's timestamp (in IST)
      const eventDateStr = formatInTimeZone(parsedTime, TIMEZONE, 'yyyy-MM-dd');
      const eventIstDate = parseAttendanceDateInput(eventDateStr);
      const attendance = await prisma.attendance.findUnique({
        where: {
          employeeId_attendanceDate: {
            employeeId,
            attendanceDate: eventIstDate,
          },
        },
      });

      if (!attendance) {
        return sendSuccess(response, "Desktop event logged, but no active attendance session found for today.", {
          logged: true,
          attendanceActive: false,
        });
      }

      let breakUpdated = false;
      let checkOutUpdated = false;

      // 2. Automate workflows based on event
      if (eventType === "LOCK" || eventType === "SLEEP" || eventType === "IDLE_START") {
        // Automatically START Break Session if breaks are enabled for this employee's shift
        const employee = await prisma.employee.findUnique({
          where: { id: employeeId },
          include: { shift: true },
        });
        const hasBreaks = employee?.shift ? employee.shift.hasBreaks : true;

        if (hasBreaks) {
          const activeBreak = await prisma.breakSession.findFirst({
            where: {
              attendanceId: attendance.id,
              endTime: null,
            },
          });

          if (!activeBreak) {
            await prisma.breakSession.create({
              data: {
                attendanceId: attendance.id,
                employeeId,
                startTime: parsedTime,
              },
            });
            breakUpdated = true;
          }
        }
      } else if (eventType === "UNLOCK" || eventType === "WAKE" || eventType === "IDLE_END") {
        // Automatically END Break Session
        const activeBreak = await prisma.breakSession.findFirst({
          where: {
            attendanceId: attendance.id,
            endTime: null,
          },
          orderBy: { startTime: "desc" },
        });

        if (activeBreak) {
          const durationMin = Math.max(0, Math.floor((parsedTime.getTime() - activeBreak.startTime.getTime()) / (1000 * 60)));
          await prisma.breakSession.update({
            where: { id: activeBreak.id },
            data: {
              endTime: parsedTime,
              durationMinutes: durationMin,
            },
          });
          breakUpdated = true;
        }
      }

      return sendSuccess(response, "Desktop event logged and workflow processed successfully", {
        logged: true,
        attendanceActive: true,
        breakUpdated,
        checkOutUpdated,
      });
    } catch (error) {
      next(error);
    } finally {
      activeDesktopEventOperations.delete(employeeId);
    }
  }
);

router.get(
  "/desktop-activity-log",
  async (request, response, next) => {
    try {
      const employeeId = request.query.employeeId ? Number(request.query.employeeId) : request.user?.employeeId;
      const dateString = request.query.date as string | undefined;

      if (!employeeId) {
        throw new AppError("Employee ID is required", 400);
      }

      // Basic auth check
      const isSelf = request.user?.employeeId === employeeId;
      const canManageOthers = request.user?.role === "HR" || request.user?.role === "ADMIN" || request.user?.role === "MANAGER" || request.user?.role === "TEAM_LEAD";
      if (!isSelf && !canManageOthers) {
        throw new AppError("Not authorized to view this data", 403);
      }

      const parsedDate = parseAttendanceDateInput(dateString);
      const nextDay = new Date(parsedDate);
      nextDay.setDate(nextDay.getDate() + 1);

      const events = await prisma.desktopActivityLog.findMany({
        where: {
          employeeId,
          timestamp: {
            gte: parsedDate,
            lt: nextDay,
          },
        },
        orderBy: { timestamp: "asc" },
      });

      const employee = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { lastDesktopActive: true },
      });

      return sendSuccess(response, "Desktop activity logs fetched successfully", { 
        events, 
        lastDesktopActive: employee?.lastDesktopActive ?? null 
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/attendance/export
 * Exports all employee attendance logs for a selected month and year as an Excel file.
 */
router.get(
  "/export",
  authenticate,
  requireRoles("ADMIN", "HR"),
  async (request, response, next) => {
    try {
      const month = parseInt(request.query.month as string, 10);
      const year = parseInt(request.query.year as string, 10);
      const type = (request.query.type as string) || "general";

      if (isNaN(month) || isNaN(year)) {
        throw new AppError("Month and year are required parameters.", 400);
      }

      // Calculate start and end date for that month in UTC
      const startOfMonth = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
      const endOfMonth = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

      // Fetch all employees
      const employees = await prisma.employee.findMany({
        where: { isActive: true },
        include: { department: true }
      });

      // Fetch all attendance for this range
      const records = await prisma.attendance.findMany({
        where: {
          attendanceDate: {
            gte: startOfMonth,
            lte: endOfMonth
          }
        },
        orderBy: { attendanceDate: "asc" }
      });

      // Map records by employeeId -> dateString
      const recordsMap = new Map<string, typeof records[0]>();
      for (const r of records) {
        const dateStr = formatInTimeZone(new Date(r.attendanceDate), TIMEZONE, "yyyy-MM-dd");
        recordsMap.set(`${r.employeeId}_${dateStr}`, r);
      }

      const MONTH_NAMES = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
      ];
      const monthName = MONTH_NAMES[month - 1];
      const daysInMonth = new Date(year, month, 0).getDate();

      const wb = XLSX.utils.book_new();

      const checkIsToday = (date: Date) => {
        const todayZoned = formatInTimeZone(new Date(), TIMEZONE, "yyyy-MM-dd");
        const targetZoned = formatInTimeZone(date, TIMEZONE, "yyyy-MM-dd");
        return todayZoned === targetZoned;
      };

      if (type === "employee") {
        // Employee-wise Monthly Sheet (tab per employee, rows = days of month)
        for (const emp of employees) {
          const empName = `${emp.firstName} ${emp.lastName}`;
          const wsData: any[][] = [];
          
          wsData.push([
            "Date",
            "Check In Time",
            "Check Out Time",
            "Worked Duration",
            "Overtime",
            "Today's Update",
            "Status"
          ]);

          for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
            const key = `${emp.id}_${dateStr}`;
            const rec = recordsMap.get(key);

            if (rec) {
              const checkInStr = rec.checkInTime ? formatInTimeZone(new Date(rec.checkInTime), TIMEZONE, "hh:mm a") : "-";
              const checkOutStr = rec.checkOutTime ? formatInTimeZone(new Date(rec.checkOutTime), TIMEZONE, "hh:mm a") : "-";
              
              let workedDuration = "-";
              if (rec.status === "LEAVE") workedDuration = "Leave";
              else if (rec.status === "ABSENT") workedDuration = "Absent";
              else if (rec.checkOutTime) {
                const hrs = Math.floor(rec.workedMinutes / 60);
                const mins = rec.workedMinutes % 60;
                workedDuration = `${hrs}h ${mins}m`;
              } else if (checkIsToday(new Date(rec.attendanceDate))) {
                workedDuration = "In progress";
              } else {
                workedDuration = "Checkout missing";
              }

              let otLabel = "-";
              const reqMins = 540 + (rec.penaltyMinutes || 0);
              if (rec.workedMinutes > reqMins) {
                const ot = rec.workedMinutes - reqMins;
                otLabel = `${Math.floor(ot / 60)}h ${ot % 60}m`;
              }

              wsData.push([
                dateStr,
                checkInStr,
                checkOutStr,
                workedDuration,
                otLabel,
                rec.todaysUpdate || "-",
                rec.status
              ]);
            } else {
              const dayOfWeek = new Date(year, month - 1, d).getDay();
              const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
              wsData.push([
                dateStr,
                "-",
                "-",
                isWeekend ? "Weekend" : "Unmarked",
                "-",
                "-",
                isWeekend ? "WEEKEND" : "UNMARKED"
              ]);
            }
          }

          const ws = XLSX.utils.aoa_to_sheet(wsData);
          // Limit sheet name to 31 chars (Excel limit)
          const safeSheetName = empName.substring(0, 30);
          XLSX.utils.book_append_sheet(wb, ws, safeSheetName);
        }
      } else {
        // General Monthly Sheet (tab per day of month, rows = employees)
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const wsData: any[][] = [];
          
          wsData.push([
            "Employee Code",
            "Employee Name",
            "Department",
            "Check In Time",
            "Check Out Time",
            "Worked Duration",
            "Overtime",
            "Today's Update",
            "Status"
          ]);

          const dayOfWeek = new Date(year, month - 1, d).getDay();
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

          for (const emp of employees) {
            const empName = `${emp.firstName} ${emp.lastName}`;
            const key = `${emp.id}_${dateStr}`;
            const rec = recordsMap.get(key);

            if (rec) {
              const checkInStr = rec.checkInTime ? formatInTimeZone(new Date(rec.checkInTime), TIMEZONE, "hh:mm a") : "-";
              const checkOutStr = rec.checkOutTime ? formatInTimeZone(new Date(rec.checkOutTime), TIMEZONE, "hh:mm a") : "-";
              
              let workedDuration = "-";
              if (rec.status === "LEAVE") workedDuration = "Leave";
              else if (rec.status === "ABSENT") workedDuration = "Absent";
              else if (rec.checkOutTime) {
                const hrs = Math.floor(rec.workedMinutes / 60);
                const mins = rec.workedMinutes % 60;
                workedDuration = `${hrs}h ${mins}m`;
              } else if (checkIsToday(new Date(rec.attendanceDate))) {
                workedDuration = "In progress";
              } else {
                workedDuration = "Checkout missing";
              }

              let otLabel = "-";
              const reqMins = 540 + (rec.penaltyMinutes || 0);
              if (rec.workedMinutes > reqMins) {
                const ot = rec.workedMinutes - reqMins;
                otLabel = `${Math.floor(ot / 60)}h ${ot % 60}m`;
              }

              wsData.push([
                emp.employeeCode,
                empName,
                emp.department?.name || "-",
                checkInStr,
                checkOutStr,
                workedDuration,
                otLabel,
                rec.todaysUpdate || "-",
                rec.status
              ]);
            } else {
              wsData.push([
                emp.employeeCode,
                empName,
                emp.department?.name || "-",
                "-",
                "-",
                isWeekend ? "Weekend" : "Unmarked",
                "-",
                "-",
                isWeekend ? "WEEKEND" : "UNMARKED"
              ]);
            }
          }

          const ws = XLSX.utils.aoa_to_sheet(wsData);
          const dayStr = String(d).padStart(2, "0");
          const tabName = `${monthName}-${dayStr}`;
          XLSX.utils.book_append_sheet(wb, ws, tabName);
        }
      }

      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      const downloadFilename = type === "employee" 
        ? `Employee_Wise_Attendance_Report_${monthName}_${year}.xlsx`
        : `General_Attendance_Report_${monthName}_${year}.xlsx`;

      response.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${downloadFilename}"`
      );
      return response.send(buffer);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
