-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "notificationEmail" TEXT,
ADD COLUMN     "sendgridApiKey" TEXT;

-- CreateTable
CREATE TABLE "custom_questions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "questionTextNormalized" TEXT NOT NULL,
    "fieldType" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSourceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_questions_userId_idx" ON "custom_questions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_questions_userId_questionTextNormalized_key" ON "custom_questions"("userId", "questionTextNormalized");

-- AddForeignKey
ALTER TABLE "custom_questions" ADD CONSTRAINT "custom_questions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
