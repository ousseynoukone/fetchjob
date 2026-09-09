-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "autoApplyNote" TEXT;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scheduleHour" INTEGER;

-- CreateTable
CREATE TABLE "platform_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "emailEncrypted" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "sessionStateEncrypted" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_items" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "url" TEXT,
    "metadata" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_credentials_userId_platform_key" ON "platform_credentials"("userId", "platform");

-- CreateIndex
CREATE INDEX "knowledge_items_userId_idx" ON "knowledge_items"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_items_userId_source_externalId_key" ON "knowledge_items"("userId", "source", "externalId");

-- AddForeignKey
ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
