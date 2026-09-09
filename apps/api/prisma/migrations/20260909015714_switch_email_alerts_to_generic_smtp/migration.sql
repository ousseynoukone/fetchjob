/*
  Warnings:

  - You are about to drop the column `sendgridApiKey` on the `settings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "settings" DROP COLUMN "sendgridApiKey",
ADD COLUMN     "smtpHost" TEXT,
ADD COLUMN     "smtpPassword" TEXT,
ADD COLUMN     "smtpPort" TEXT,
ADD COLUMN     "smtpUsername" TEXT;
