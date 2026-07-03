import { PrismaClient } from "@prisma/client";
import { getGoogleClients, initializeMonthlySheets, MONTH_NAMES } from "./googleSheets.service.js";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { sendEmail } from "./mailer.js";

const prisma = new PrismaClient();
let isRunning = false;
const TIMEZONE = "Asia/Kolkata";
const dailySheetCodesCache: Record<string, string[]> = {};

const existingTabsCache: Record<string, Set<string>> = {};

/**
 * Fetch and cache the list of tab titles for a spreadsheet if not already cached
 */
async function getCachedTabs(spreadsheetId: string, sheetsClient: any): Promise<Set<string>> {
  if (!existingTabsCache[spreadsheetId]) {
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
    const titles = (meta.data.sheets || []).map((s: any) => s.properties?.title).filter(Boolean);
    existingTabsCache[spreadsheetId] = new Set(titles);
  }
  return existingTabsCache[spreadsheetId];
}

/**
 * Main worker loop invoked by the Scheduler
 */
export async function processGoogleSheetSyncQueue() {
  if (process.env.DISABLE_GOOGLE_SHEETS_SYNC === "true") {
    return;
  }
  if (isRunning) return;
  
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return; // Silently ignore if Google credentials aren't configured
  }

  isRunning = true;
  try {
    const pendingTasks = await prisma.googleSheetSyncQueue.findMany({
      where: { status: "PENDING" },
      take: 20, // Batch limit to prevent API quotas
      orderBy: { createdAt: "asc" }
    });

    if (pendingTasks.length === 0) {
      isRunning = false;
      return;
    }

    console.log(`[GoogleSheetsWorker] Processing ${pendingTasks.length} pending sync tasks...`);
    const { sheetsClient } = await getGoogleClients();

    for (const task of pendingTasks) {
      try {
        if (task.entityType === "ATTENDANCE") {
          const attendance = await prisma.attendance.findUnique({
            where: { id: task.entityId },
            include: { employee: { include: { department: true, manager: true } } }
          });

          if (!attendance) {
            // If the record doesn't exist, complete the task
            await prisma.googleSheetSyncQueue.update({
              where: { id: task.id },
              data: { status: "COMPLETED", lastError: null }
            });
            continue;
          }

          const dateObj = toZonedTime(new Date(attendance.attendanceDate), TIMEZONE);
          const year = dateObj.getFullYear();
          const month = dateObj.getMonth() + 1;
          const config = await initializeMonthlySheets(year, month);

          await syncAttendanceToSheets(attendance, config, sheetsClient);
        }
        
        await prisma.googleSheetSyncQueue.update({
          where: { id: task.id },
          data: { status: "COMPLETED", lastError: null }
        });
      } catch (err: any) {
        console.error(`[GoogleSheetsWorker] Task ${task.id} failed:`, err.message);
        const retryCount = task.retryCount + 1;
        const isFinalFailure = retryCount >= 3;
        
        await prisma.googleSheetSyncQueue.update({
          where: { id: task.id },
          data: { 
            status: isFinalFailure ? "FAILED" : "PENDING",
            retryCount,
            lastError: err.message
          }
        });

        if (isFinalFailure && process.env.HR_ADMIN_EMAIL) {
          try {
            await sendEmail(
              process.env.HR_ADMIN_EMAIL,
              "🚨 HRMS Alert: Google Sheets Sync Failed",
              `<h3>Google Sheets Sync Failure Alert</h3>
               <p>A Google Sheets synchronization task has failed after 3 attempts.</p>
               <ul>
                 <li><strong>Task ID:</strong> ${task.id}</li>
                 <li><strong>Entity Type:</strong> ${task.entityType}</li>
                 <li><strong>Entity ID:</strong> ${task.entityId}</li>
                 <li><strong>Error:</strong> ${err.message}</li>
               </ul>
               <p>Please check the background service logs or verify that the Google Spreadsheet has been correctly shared with the service account email.</p>`
            );
            console.log(`[GoogleSheetsWorker] Sent sync failure email to ${process.env.HR_ADMIN_EMAIL}`);
          } catch (mailErr: any) {
            console.error("[GoogleSheetsWorker] Failed to send alert email:", mailErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error("[GoogleSheetsWorker] Global error:", err);
  } finally {
    isRunning = false;
  }
}

/**
 * Handles logic to sync both Workbooks for a specific attendance record
 */
export async function syncAttendanceToSheets(attendance: any, config: any, sheetsClient: any) {
  // Query overtime session
  const overtimeSession = await prisma.overtimeSession.findUnique({
    where: {
      employeeId_date: {
        employeeId: attendance.employeeId,
        date: attendance.attendanceDate
      }
    }
  });

  const emp = attendance.employee;
  
  // 1. Sync to Employee Monthly Spreadsheet
  await syncEmployeeAttendanceTab(attendance, overtimeSession, emp, config.attendanceId, sheetsClient);
  
  // 2. Sync to Daily Attendance Spreadsheet
  await syncDailyAttendanceTab(attendance, overtimeSession, emp, config.updatesId, sheetsClient);
}

/**
 * Updates the specific row in the individual employee's tab
 */
async function syncEmployeeAttendanceTab(attendance: any, overtimeSession: any, emp: any, spreadsheetId: string, sheetsClient: any) {
  const sheetName = `${emp.firstName} ${emp.lastName}`;
  const dateObj = toZonedTime(new Date(attendance.attendanceDate), TIMEZONE);
  const day = dateObj.getDate();
  const rowIndex = day + 1; // Row 1 = Header, Row 2 = 1st, Row 3 = 2nd

  // Ensure sheet tab exists with pre-populated dates of that month
  await ensureEmployeeSheetExists(spreadsheetId, sheetsClient, sheetName, dateObj);

  // Prepare fields
  const checkInStr = formatAttendanceTime(attendance.checkInTime);
  const checkOutStr = formatAttendanceTime(attendance.checkOutTime);
  const durationStr = (attendance.status === "PRESENT" || attendance.status === "HALF_DAY") 
    ? formatWorkedDuration(attendance.workedMinutes) 
    : "-";
  const overtimeStr = getOvertimeLabel(attendance, overtimeSession);
  const updateStr = attendance.todaysUpdate || "-";
  const statusStr = await getFormattedStatus(attendance);

  // Update cells starting from Column B (Check In) to G (Status)
  const range = `${sheetName}!B${rowIndex}:G${rowIndex}`;
  
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[checkInStr, checkOutStr, durationStr, overtimeStr, updateStr, statusStr]]
    }
  });
}

/**
 * Updates the specific row in the daily tab containing all employees
 */
async function syncDailyAttendanceTab(attendance: any, overtimeSession: any, emp: any, spreadsheetId: string, sheetsClient: any) {
  const dateObj = toZonedTime(new Date(attendance.attendanceDate), TIMEZONE);
  const monthName = MONTH_NAMES[dateObj.getMonth()];
  const dayStr = String(dateObj.getDate()).padStart(2, "0");
  const sheetName = `${monthName}-${dayStr}`;

  // Ensure sheet tab exists with all active employees pre-populated
  await ensureDailySheetExists(spreadsheetId, sheetsClient, sheetName);

  // Find the employee row index using cached column A values
  const cacheKey = `${spreadsheetId}:${sheetName}`;
  if (!dailySheetCodesCache[cacheKey]) {
    const colARes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:A`
    });
    const codes = colARes.data.values || [];
    dailySheetCodesCache[cacheKey] = codes.map((row: any) => row[0] || "");
  }

  let rowIndex = dailySheetCodesCache[cacheKey].indexOf(emp.employeeCode) + 1;

  if (rowIndex === 0) {
    // Employee not found (newly added). Append employee to daily sheet
    console.log(`[GoogleSheetsWorker] Employee ${emp.employeeCode} not found in daily tab '${sheetName}'. Appending...`);
    const newRow = [
      emp.employeeCode,
      `${emp.firstName} ${emp.lastName}`,
      "-",
      "-",
      "-",
      "-",
      "-",
      "Unmarked"
    ];
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:H`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [newRow] }
    });

    // Refresh the cache
    const colAResRetry = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:A`
    });
    const codesRetry = colAResRetry.data.values || [];
    dailySheetCodesCache[cacheKey] = codesRetry.map((row: any) => row[0] || "");
    rowIndex = dailySheetCodesCache[cacheKey].indexOf(emp.employeeCode) + 1;
  }

  // Update check-in, check-out, duration, overtime, update, and status (Columns C to H)
  const checkInStr = formatAttendanceTime(attendance.checkInTime);
  const checkOutStr = formatAttendanceTime(attendance.checkOutTime);
  const durationStr = (attendance.status === "PRESENT" || attendance.status === "HALF_DAY") 
    ? formatWorkedDuration(attendance.workedMinutes) 
    : "-";
  const overtimeStr = getOvertimeLabel(attendance, overtimeSession);
  const updateStr = attendance.todaysUpdate || "-";
  const statusStr = await getFormattedStatus(attendance);

  const range = `${sheetName}!C${rowIndex}:H${rowIndex}`;
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[checkInStr, checkOutStr, durationStr, overtimeStr, updateStr, statusStr]]
    }
  });
}

/**
 * Helper to dynamically create an employee sheet tab if it doesn't exist
 */
async function ensureEmployeeSheetExists(spreadsheetId: string, sheetsClient: any, sheetName: string, dateObj: Date) {
  const cached = await getCachedTabs(spreadsheetId, sheetsClient);
  if (cached.has(sheetName)) return;

  console.log(`[GoogleSheetsWorker] Creating missing employee tab '${sheetName}'...`);
  const addRes = await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: { properties: { title: sheetName } }
        }
      ]
    }
  });

  const newSheetId = addRes.data?.replies?.[0]?.addSheet?.properties?.sheetId;
  cached.add(sheetName);
  const headers = ["Date", "Check In", "Check Out", "Worked Duration", "Overtime", "Today's Update", "Status"];

  // Write headers to Row 1
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1:G1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers] }
  });

  // Pre-populate Column A with dates of the month, columns B-G with "-"
  const year = dateObj.getFullYear();
  const month = dateObj.getMonth();
  const numDays = new Date(year, month + 1, 0).getDate();
  const monthName = MONTH_NAMES[month];

  const initialRows = [];
  for (let d = 1; d <= numDays; d++) {
    const dayStr = String(d).padStart(2, "0");
    const dateLabel = `${monthName}-${dayStr}`;
    initialRows.push([dateLabel, "-", "-", "-", "-", "-", "-"]);
  }

  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A2:G${numDays + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: initialRows }
  });

  // Format and style the sheet
  if (newSheetId !== undefined) {
    const colWidths = [100, 100, 100, 130, 130, 350, 120];
    const requests: any[] = [];
    
    // Column Widths
    colWidths.forEach((width, idx) => {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: idx, endIndex: idx + 1 },
          properties: { pixelSize: width },
          fields: "pixelSize"
        }
      });
    });

    // Header Row Height
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: newSheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 35 },
        fields: "pixelSize"
      }
    });

    // Body Row Height
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: newSheetId, dimension: "ROWS", startIndex: 1, endIndex: numDays + 1 },
        properties: { pixelSize: 26 },
        fields: "pixelSize"
      }
    });

    // Header Format
    requests.push({
      repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.17, green: 0.24, blue: 0.31 },
            textFormat: { bold: true, foregroundColor: { red: 1.0, green: 1.0, blue: 1.0 }, fontSize: 10, fontFamily: "Arial" },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE"
          }
        },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment"
      }
    });

    // Body Format (vertical align middle, clip wrap strategy)
    requests.push({
      repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: numDays + 1, startColumnIndex: 0, endColumnIndex: 7 },
        cell: {
          userEnteredFormat: {
            textFormat: { fontSize: 10, fontFamily: "Arial" },
            verticalAlignment: "MIDDLE",
            wrapStrategy: "CLIP"
          }
        },
        fields: "userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy"
      }
    });

    // Center columns A-E and G
    requests.push({
      repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: numDays + 1, startColumnIndex: 0, endColumnIndex: 5 },
        cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat.horizontalAlignment"
      }
    });
    requests.push({
      repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: numDays + 1, startColumnIndex: 6, endColumnIndex: 7 },
        cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat.horizontalAlignment"
      }
    });

    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests }
    }).catch((err: any) => console.error("Failed to style employee sheet:", err.message));
  }
}

/**
 * Helper to dynamically create a daily sheet tab if it doesn't exist
 */
async function ensureDailySheetExists(spreadsheetId: string, sheetsClient: any, sheetName: string) {
  const cached = await getCachedTabs(spreadsheetId, sheetsClient);
  if (cached.has(sheetName)) return;

  console.log(`[GoogleSheetsWorker] Creating missing daily tab '${sheetName}'...`);
  const addRes = await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: { properties: { title: sheetName } }
        }
      ]
    }
  });

  const newSheetId = addRes.data?.replies?.[0]?.addSheet?.properties?.sheetId;
  cached.add(sheetName);
  const headers = ["Employee Code", "Employee Name", "Check In", "Check Out", "Worked Duration", "Overtime", "Today's Update", "Status"];

  // Write headers to Row 1
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1:H1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers] }
  });

  // Query all active employees sorted by employeeCode
  const activeEmployees = await prisma.employee.findMany({
    where: { employmentStatus: "ACTIVE", isActive: true },
    orderBy: { employeeCode: "asc" }
  });

  const employeeRows = activeEmployees.map(e => [
    e.employeeCode,
    `${e.firstName} ${e.lastName}`,
    "-",
    "-",
    "-",
    "-",
    "-",
    "Unmarked"
  ]);

  if (employeeRows.length > 0) {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A2:H${activeEmployees.length + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: employeeRows }
    });
  }

  // Format and style the sheet
  if (newSheetId !== undefined) {
    const colWidths = [110, 160, 100, 100, 130, 130, 350, 120];
    const requests: any[] = [];
    
    // Column Widths
    colWidths.forEach((width, idx) => {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: idx, endIndex: idx + 1 },
          properties: { pixelSize: width },
          fields: "pixelSize"
        }
      });
    });

    // Header Row Height
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: newSheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 35 },
        fields: "pixelSize"
      }
    });

    // Body Row Height
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: newSheetId, dimension: "ROWS", startIndex: 1, endIndex: activeEmployees.length + 1 },
        properties: { pixelSize: 26 },
        fields: "pixelSize"
      }
    });

    // Header Format
    requests.push({
      repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.17, green: 0.24, blue: 0.31 },
            textFormat: { bold: true, foregroundColor: { red: 1.0, green: 1.0, blue: 1.0 }, fontSize: 10, fontFamily: "Arial" },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE"
          }
        },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment"
      }
    });

    // Body Format (vertical align middle, clip wrap strategy)
    requests.push({
      repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: activeEmployees.length + 1, startColumnIndex: 0, endColumnIndex: 8 },
        cell: {
          userEnteredFormat: {
            textFormat: { fontSize: 10, fontFamily: "Arial" },
            verticalAlignment: "MIDDLE",
            wrapStrategy: "CLIP"
          }
        },
        fields: "userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy"
      }
    });

    // Center columns A, C-F, H
    requests.push({
      repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: activeEmployees.length + 1, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat.horizontalAlignment"
      }
    });
    requests.push({
      repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: activeEmployees.length + 1, startColumnIndex: 2, endColumnIndex: 6 },
        cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat.horizontalAlignment"
      }
    });
    requests.push({
      repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: activeEmployees.length + 1, startColumnIndex: 7, endColumnIndex: 8 },
        cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat.horizontalAlignment"
      }
    });

    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests }
    }).catch((err: any) => console.error("Failed to style daily sheet:", err.message));
  }
}

// FORMATTING HELPERS

function formatWorkedDuration(workedMinutes: number): string {
  if (!workedMinutes || workedMinutes <= 0) {
    return "-";
  }

  const hours = Math.floor(workedMinutes / 60);
  const minutes = workedMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h`;
  }

  return `${minutes}m`;
}

function formatAttendanceTime(value: any): string {
  return value
    ? formatInTimeZone(new Date(value), TIMEZONE, 'h:mm a')
    : "-";
}

function getOvertimeLabel(attendance: any, overtimeSession: any): string {
  if (!overtimeSession) {
    if (attendance.workedMinutes > 540) {
      const otMins = attendance.workedMinutes - 540;
      return `'+${formatWorkedDuration(otMins)}`;
    }
    return "-";
  }

  const { duration, status } = overtimeSession;
  
  if (status === "REJECTED") {
    return "Rejected";
  }

  const durationLabel = duration ? formatWorkedDuration(duration) : "0m";

  if (status === "VERIFIED") {
    return `'+${durationLabel}`;
  }

  if (status === "ACTIVE") {
    return "Active";
  }

  return `${durationLabel} (Pending)`;
}

async function getLeaveTypeCode(employeeId: number, date: Date, status: string): Promise<string | null> {
  if (status !== "LEAVE" && status !== "HALF_DAY") return null;
  const start = new Date(date);
  start.setHours(0,0,0,0);
  
  const leave = await prisma.leaveRequest.findFirst({
    where: {
      employeeId,
      status: "APPROVED",
      startDate: { lte: start },
      endDate: { gte: start }
    },
    include: { leaveType: true }
  });
  
  return leave?.leaveType?.code || null;
}

async function getFormattedStatus(attendance: any): Promise<string> {
  const status = attendance.status;
  const baseLabel = status === "HALF_DAY" ? "Half day" : status.charAt(0) + status.slice(1).toLowerCase();

  if (status === "LEAVE" || status === "HALF_DAY") {
    const leaveTypeCode = await getLeaveTypeCode(attendance.employeeId, attendance.attendanceDate, status);
    if (leaveTypeCode) {
      return `${baseLabel} (${leaveTypeCode})`;
    }
  }

  return baseLabel;
}
