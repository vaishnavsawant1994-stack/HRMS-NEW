import dotenv from "dotenv";
dotenv.config();

import { PrismaClient } from "@prisma/client";
import { getGoogleClients, initializeMonthlySheets } from "../src/services/googleSheets.service.js";
import { syncAttendanceToSheets } from "../src/services/googleSheetsWorker.js";
import { toZonedTime } from "date-fns-tz";

const prisma = new PrismaClient();
const TIMEZONE = "Asia/Kolkata";

async function runBackfill() {
  console.log("Starting Google Sheets backfill for May and June 2026...");
  
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error("GOOGLE_APPLICATION_CREDENTIALS is not defined in environment!");
    process.exit(1);
  }
  
  const startRange = new Date("2026-05-01T00:00:00.000Z");
  const endRange = new Date("2026-07-31T23:59:59.999Z");

  const records = await prisma.attendance.findMany({
    where: {
      attendanceDate: {
        gte: startRange,
        lte: endRange
      }
    },
    include: {
      employee: {
        include: {
          department: true,
          manager: true
        }
      }
    },
    orderBy: {
      attendanceDate: "asc"
    }
  });

  console.log(`Found ${records.length} attendance records to process.`);

  const { sheetsClient } = await getGoogleClients();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const dateObj = toZonedTime(new Date(record.attendanceDate), TIMEZONE);
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth() + 1;
    const dateStr = dateObj.toISOString().split("T")[0];
    const empName = `${record.employee.firstName} ${record.employee.lastName}`;

    console.log(`[${i + 1}/${records.length}] Syncing ${empName} for date ${dateStr}...`);

    try {
      const config = await initializeMonthlySheets(year, month);
      await syncAttendanceToSheets(record, config, sheetsClient);
    } catch (err: any) {
      console.error(`Failed to sync record ID ${record.id} (${empName} on ${dateStr}):`, err.message);
    }
    
    // Add small delay to prevent rapid Google Sheets API rate limit issues (60 requests/minute per user)
    // Wait for 2.5 seconds between records
    await new Promise(resolve => setTimeout(resolve, 2500));
  }

  console.log("Backfill completed!");
}

runBackfill()
  .catch(err => {
    console.error("Fatal backfill error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
