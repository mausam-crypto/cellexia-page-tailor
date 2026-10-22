-- AlterTable
ALTER TABLE "Article" ADD COLUMN "illustrationPlan" TEXT;
ALTER TABLE "Article" ADD COLUMN "pendingFigureJob" TEXT;

-- CreateTable
CREATE TABLE "IllustrationTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "seedKey" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "whenToUse" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "shape" TEXT NOT NULL DEFAULT 'landscape',
    "exampleImageId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IllustrationTemplate_exampleImageId_fkey" FOREIGN KEY ("exampleImageId") REFERENCES "IllustrationImage" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IllustrationImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "language" TEXT,
    "shopifyFileId" TEXT NOT NULL,
    "cdnUrl" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" INTEGER,
    "templateId" TEXT,
    "specificPrompt" TEXT,
    "finalPrompt" TEXT,
    "rationale" TEXT,
    "model" TEXT,
    "quality" TEXT,
    "size" TEXT,
    "costUsd" REAL,
    "sourceArticleId" TEXT,
    "sourceSurfaceKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IllustrationImage_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "IllustrationTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IllustrationCharge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "imageId" TEXT,
    "articleId" TEXT,
    "surfaceKey" TEXT,
    "model" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" REAL NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IllustrationCharge_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "IllustrationImage" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Override" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "surfaceKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "selector" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "original" TEXT NOT NULL,
    "adapted" TEXT NOT NULL,
    "notes" TEXT,
    "warnings" TEXT,
    "articleClaims" TEXT,
    "unverifiedClaims" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "figureImageId" TEXT,
    "figureCaption" TEXT,
    "figureAlt" TEXT,
    "figureAlternatives" TEXT,
    "figureSource" TEXT,
    "figureError" TEXT,
    "figureLastJob" TEXT,
    CONSTRAINT "Override_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Override_figureImageId_fkey" FOREIGN KEY ("figureImageId") REFERENCES "IllustrationImage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Override" ("adapted", "articleClaims", "articleId", "enabled", "id", "label", "mode", "notes", "original", "selector", "surfaceKey", "unverifiedClaims", "warnings") SELECT "adapted", "articleClaims", "articleId", "enabled", "id", "label", "mode", "notes", "original", "selector", "surfaceKey", "unverifiedClaims", "warnings" FROM "Override";
DROP TABLE "Override";
ALTER TABLE "new_Override" RENAME TO "Override";
CREATE UNIQUE INDEX "Override_articleId_surfaceKey_key" ON "Override"("articleId", "surfaceKey");
CREATE TABLE "new_ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "paramName" TEXT NOT NULL DEFAULT 'cx',
    "intensity" TEXT NOT NULL DEFAULT 'light',
    "surfaces" TEXT NOT NULL DEFAULT '[]',
    "subtleSettings" TEXT NOT NULL DEFAULT '{}',
    "illustrationSettings" TEXT NOT NULL DEFAULT '{}',
    "servingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("intensity", "paramName", "servingEnabled", "shop", "subtleSettings", "surfaces", "updatedAt") SELECT "intensity", "paramName", "servingEnabled", "shop", "subtleSettings", "surfaces", "updatedAt" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "IllustrationTemplate_shop_idx" ON "IllustrationTemplate"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "IllustrationTemplate_shop_seedKey_key" ON "IllustrationTemplate"("shop", "seedKey");

-- CreateIndex
CREATE INDEX "IllustrationImage_shop_createdAt_idx" ON "IllustrationImage"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "IllustrationImage_shop_kind_idx" ON "IllustrationImage"("shop", "kind");

-- CreateIndex
CREATE INDEX "IllustrationCharge_shop_createdAt_idx" ON "IllustrationCharge"("shop", "createdAt");
