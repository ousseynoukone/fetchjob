-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "verificationScreenshot" BYTEA,
ADD COLUMN     "verificationScreenshotTakenAt" TIMESTAMP(3);
