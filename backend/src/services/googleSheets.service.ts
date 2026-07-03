import { google } from "googleapis";
import { PrismaClient } from "@prisma/client";
import fs from "fs";

const prisma = new PrismaClient();

let sheetsClient: any = null;
let driveClient: any = null;

/**
 * Initializes and returns Google API clients using the service account credentials.
 */
export async function getGoogleClients() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS environment variable is not set. Background sync will not run.");
  }

  if (!sheetsClient || !driveClient) {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive"
      ],
    });
    
    const authClient = await auth.getClient();
    sheetsClient = google.sheets({ version: "v4", auth: authClient as any });
    driveClient = google.drive({ version: "v3", auth: authClient as any });
  }

  return { sheetsClient, driveClient };
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/**
 * Helper to search Google Drive for a spreadsheet by name
 */
export async function findSpreadsheetByName(title: string): Promise<string | null> {
  const { driveClient } = await getGoogleClients();
  try {
    const res = await driveClient.files.list({
      q: `name = '${title.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      spaces: 'drive',
      fields: 'files(id, name)',
      pageSize: 1
    });
    const files = res.data.files || [];
    if (files.length > 0) {
      return files[0].id || null;
    }
  } catch (err: any) {
    console.error(`[GoogleSheets] Failed to search for spreadsheet '${title}':`, err.message);
  }
  return null;
}

/**
 * Helper to dynamically extract the service account email
 */
function getServiceAccountEmail(): string {
  try {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credPath) {
      const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
      return creds.client_email || "your service account email";
    }
  } catch (err) {}
  return "your service account email";
}

/**
 * Checks if the Google Workbooks exist for the given year and month.
 * If not, it creates them via the Google Drive API and saves the IDs to the database.
 */
export async function initializeMonthlySheets(year: number, month: number) {
  const { sheetsClient, driveClient } = await getGoogleClients();
  
  const configKey = year * 100 + month; // E.g. 202606
  
  let config = await prisma.googleSheetConfig.findUnique({ where: { year: configKey } });
  
  if (!config) {
    config = await prisma.googleSheetConfig.create({
      data: { year: configKey }
    });
  }

  const monthName = MONTH_NAMES[month - 1];

  // 1. Initialize Individual Monthly Attendance Sheet (e.g. "HRMS-June 2026")
  if (!config.attendanceId) {
    const title = `HRMS-${monthName} ${year}`;
    // First, try to find it in shared drive files
    const existingId = await findSpreadsheetByName(title);
    if (existingId) {
      console.log(`[GoogleSheets] Found existing spreadsheet '${title}' with ID: ${existingId}`);
      config = await prisma.googleSheetConfig.update({
        where: { id: config.id },
        data: { attendanceId: existingId }
      });
    } else {
      console.log(`[GoogleSheets] Creating '${title}' spreadsheet...`);
      try {
        const attendanceRes = await sheetsClient.spreadsheets.create({
          requestBody: {
            properties: { title },
            sheets: [
              {
                properties: { title: "Index" }
              }
            ]
          }
        });

        const attendanceId = attendanceRes.data.spreadsheetId;

        if (process.env.HR_ADMIN_EMAIL) {
          try {
            await driveClient.permissions.create({
              fileId: attendanceId,
              requestBody: { type: "user", role: "writer", emailAddress: process.env.HR_ADMIN_EMAIL }
            });
            console.log(`[GoogleSheets] Shared attendance sheet with ${process.env.HR_ADMIN_EMAIL}`);
          } catch (err: any) {
            console.error(`[GoogleSheets] Failed to share attendance sheet:`, err.message);
          }
        }

        config = await prisma.googleSheetConfig.update({
          where: { id: config.id },
          data: { attendanceId }
        });
      } catch (err: any) {
        const saEmail = getServiceAccountEmail();
        console.error(`[GoogleSheets] Failed to create spreadsheet '${title}':`, err.message);
        throw new Error(
          `Could not create spreadsheet '${title}'. Reason: ${err.message}. ` +
          `If you are using a free Gmail account, please create a spreadsheet named '${title}' in your Google Drive ` +
          `and share it with '${saEmail}' as an Editor.`
        );
      }
    }
  }

  // 2. Daily Attendance Sheet (e.g. "HRMS-Daily Attendance June 2026")
  if (!config.updatesId) {
    const title = `HRMS-Daily Attendance ${monthName} ${year}`;
    const existingId = await findSpreadsheetByName(title);
    if (existingId) {
      console.log(`[GoogleSheets] Found existing spreadsheet '${title}' with ID: ${existingId}`);
      config = await prisma.googleSheetConfig.update({
        where: { id: config.id },
        data: { updatesId: existingId }
      });
    } else {
      console.log(`[GoogleSheets] Creating '${title}' spreadsheet...`);
      try {
        const updatesRes = await sheetsClient.spreadsheets.create({
          requestBody: {
            properties: { title },
            sheets: [
              {
                properties: { title: "Index" }
              }
            ]
          }
        });

        const updatesId = updatesRes.data.spreadsheetId;

        if (process.env.HR_ADMIN_EMAIL) {
          try {
            await driveClient.permissions.create({
              fileId: updatesId,
              requestBody: { type: "user", role: "writer", emailAddress: process.env.HR_ADMIN_EMAIL }
            });
            console.log(`[GoogleSheets] Shared daily attendance sheet with ${process.env.HR_ADMIN_EMAIL}`);
          } catch (err: any) {
            console.error(`[GoogleSheets] Failed to share daily attendance sheet:`, err.message);
          }
        }

        config = await prisma.googleSheetConfig.update({
          where: { id: config.id },
          data: { updatesId }
        });
      } catch (err: any) {
        const saEmail = getServiceAccountEmail();
        console.error(`[GoogleSheets] Failed to create spreadsheet '${title}':`, err.message);
        throw new Error(
          `Could not create spreadsheet '${title}'. Reason: ${err.message}. ` +
          `If you are using a free Gmail account, please create a spreadsheet named '${title}' in your Google Drive ` +
          `and share it with '${saEmail}' as an Editor.`
        );
      }
    }
  }

  return config;
}

export async function queueAttendanceSync(attendanceId: number) {
  if (process.env.DISABLE_GOOGLE_SHEETS_SYNC === "true") {
    return;
  }
  await prisma.googleSheetSyncQueue.create({
    data: {
      entityType: "ATTENDANCE",
      entityId: attendanceId,
      action: "UPSERT"
    }
  });
}
