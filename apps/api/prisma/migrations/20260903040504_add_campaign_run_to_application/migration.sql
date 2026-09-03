-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "campaignRunId" TEXT;

-- CreateIndex
CREATE INDEX "applications_campaignRunId_idx" ON "applications"("campaignRunId");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_campaignRunId_fkey" FOREIGN KEY ("campaignRunId") REFERENCES "campaign_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
