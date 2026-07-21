-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "paramName" TEXT NOT NULL DEFAULT 'cx',
    "intensity" TEXT NOT NULL DEFAULT 'light',
    "surfaces" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productHandle" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "sourceText" TEXT,
    "detectedQuery" TEXT,
    "queryVariants" TEXT,
    "evidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "variantHandle" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Override" (
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
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Override_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Article_variantHandle_key" ON "Article"("variantHandle");

-- CreateIndex
CREATE INDEX "Article_shop_productId_locale_idx" ON "Article"("shop", "productId", "locale");

-- CreateIndex
CREATE INDEX "Article_shop_status_idx" ON "Article"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Override_articleId_surfaceKey_key" ON "Override"("articleId", "surfaceKey");
