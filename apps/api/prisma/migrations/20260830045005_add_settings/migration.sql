-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "deepseekApiKey" TEXT,
    "franceTravailClientId" TEXT,
    "franceTravailClientSecret" TEXT,
    "adzunaAppId" TEXT,
    "adzunaApiKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);
