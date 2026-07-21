-- CreateTable
CREATE TABLE "DailyStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "productHandle" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "variantViews" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "lineRevenue" REAL NOT NULL,
    "orderTotal" REAL NOT NULL,
    "customerLocale" TEXT
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productHandle" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "baselineStart" DATETIME NOT NULL,
    "baselineEnd" DATETIME NOT NULL,
    "treatmentStart" DATETIME NOT NULL,
    "treatmentEnd" DATETIME NOT NULL,
    "stoppedAt" DATETIME,
    "stopReason" TEXT,
    "lastOrderSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "paramName" TEXT NOT NULL DEFAULT 'cx',
    "intensity" TEXT NOT NULL DEFAULT 'light',
    "surfaces" TEXT NOT NULL DEFAULT '[]',
    "servingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("intensity", "paramName", "shop", "surfaces", "updatedAt") SELECT "intensity", "paramName", "shop", "surfaces", "updatedAt" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DailyStat_shop_productHandle_idx" ON "DailyStat"("shop", "productHandle");

-- CreateIndex
CREATE UNIQUE INDEX "DailyStat_shop_dateKey_productHandle_locale_key" ON "DailyStat"("shop", "dateKey", "productHandle", "locale");

-- CreateIndex
CREATE INDEX "OrderLine_shop_productId_dateKey_idx" ON "OrderLine"("shop", "productId", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_orderId_productId_key" ON "OrderLine"("orderId", "productId");

-- CreateIndex
CREATE INDEX "Experiment_shop_status_idx" ON "Experiment"("shop", "status");
