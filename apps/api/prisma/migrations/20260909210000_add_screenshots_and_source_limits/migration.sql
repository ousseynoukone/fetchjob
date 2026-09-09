-- AlterTable
ALTER TABLE "applications" ADD COLUMN "screenshot" BYTEA,
ADD COLUMN "screenshotTakenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN "sourceDailyLimits" JSONB NOT NULL DEFAULT '{}';
