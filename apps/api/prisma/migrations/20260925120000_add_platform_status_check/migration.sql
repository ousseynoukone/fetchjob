-- AlterTable
ALTER TABLE "settings" ADD COLUMN "platformStatusCheckIntervalHours" TEXT;
ALTER TABLE "settings" ADD COLUMN "lastPlatformStatusCheckAt" TIMESTAMP(3);
