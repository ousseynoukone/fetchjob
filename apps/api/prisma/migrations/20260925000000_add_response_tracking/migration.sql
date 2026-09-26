-- AlterTable
ALTER TABLE "applications" ADD COLUMN "hasUnseenUpdate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "applications" ADD COLUMN "autoUpdateSummary" TEXT;
ALTER TABLE "applications" ADD COLUMN "autoUpdateAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "settings" ADD COLUMN "responseCheckIntervalHours" TEXT;
ALTER TABLE "settings" ADD COLUMN "lastResponseCheckAt" TIMESTAMP(3);
