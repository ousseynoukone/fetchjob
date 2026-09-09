-- AlterTable
ALTER TABLE "applications" ADD COLUMN "verifiedAt" TIMESTAMP(3),
ADD COLUMN "verificationNote" TEXT;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN "digestIntervalHours" TEXT,
ADD COLUMN "lastDigestSentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "verification_runs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "checked" INTEGER NOT NULL DEFAULT 0,
    "confirmed" INTEGER NOT NULL DEFAULT 0,
    "unconfirmed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "logs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "verification_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verification_runs_userId_idx" ON "verification_runs"("userId");

-- AddForeignKey
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
