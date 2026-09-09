-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "autoApplyMaxDelaySeconds" INTEGER NOT NULL DEFAULT 150,
ADD COLUMN     "autoApplyMinDelaySeconds" INTEGER NOT NULL DEFAULT 45;
