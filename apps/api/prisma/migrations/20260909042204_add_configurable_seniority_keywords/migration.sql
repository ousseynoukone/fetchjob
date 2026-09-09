-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "seniorityKeywords" TEXT[] NOT NULL DEFAULT ARRAY['senior', 'lead', 'staff', 'principal', 'architecte', 'architect', 'confirme', 'expert', 'manager', 'directeur', 'director']::TEXT[];
