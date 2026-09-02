-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "excludeKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "maxAgeMonths" INTEGER NOT NULL DEFAULT 0;
