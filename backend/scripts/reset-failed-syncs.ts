import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function run() {
  console.log("Resetting failed Google Sheets sync tasks to PENDING...");
  
  try {
    const result = await prisma.googleSheetSyncQueue.updateMany({
      where: { status: "FAILED" },
      data: {
        status: "PENDING",
        retryCount: 0,
        lastError: null
      }
    });

    console.log(`Successfully reset ${result.count} failed tasks to PENDING status.`);
  } catch (err: any) {
    console.error("Error resetting failed tasks:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

run();
