import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();

async function run() {
  console.log("Querying database for Google Sheets Sync diagnostic info...");
  
  try {
    // 1. Fetch configs
    const configs = await prisma.googleSheetConfig.findMany({
      orderBy: { year: "asc" }
    });

    // 2. Fetch queue summary
    const statusCounts = await prisma.googleSheetSyncQueue.groupBy({
      by: ["status"],
      _count: { id: true }
    });

    // 3. Fetch failed tasks with error messages
    const failedTasks = await prisma.googleSheetSyncQueue.findMany({
      where: { status: "FAILED" },
      orderBy: { updatedAt: "desc" },
      take: 20
    });

    // 4. Fetch pending tasks count
    const pendingTasksCount = await prisma.googleSheetSyncQueue.count({
      where: { status: "PENDING" }
    });

    // 5. Fetch completed tasks count
    const completedTasksCount = await prisma.googleSheetSyncQueue.count({
      where: { status: "COMPLETED" }
    });

    const report = {
      timestamp: new Date().toISOString(),
      googleSheetConfigs: configs,
      queueSummary: {
        totalPending: pendingTasksCount,
        totalCompleted: completedTasksCount,
        totalFailed: failedTasks.length,
        statusGrouped: statusCounts
      },
      failedTasksSample: failedTasks.map(t => ({
        id: t.id,
        entityType: t.entityType,
        entityId: t.entityId,
        action: t.action,
        retryCount: t.retryCount,
        lastError: t.lastError,
        updatedAt: t.updatedAt
      }))
    };

    const outPath = path.join("d:\\Intellisys\\HRMS-NEW", "google_sync_diagnostic.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`Diagnostic report written successfully to: ${outPath}`);
  } catch (err: any) {
    console.error("Error executing database diagnostic query:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

run();
