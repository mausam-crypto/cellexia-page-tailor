-- AlterTable
ALTER TABLE "Override" ADD COLUMN "unverifiedClaims" TEXT;

-- CreateTable
CREATE TABLE "VariantVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "instruction" TEXT,
    "surfaces" TEXT NOT NULL,
    "modelNotes" TEXT,
    "runWarnings" TEXT,
    "changedSurfaces" TEXT,
    "restoredFrom" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VariantVersion_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Article" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productHandle" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "sourceText" TEXT,
    "sourceKind" TEXT NOT NULL DEFAULT 'article',
    "briefName" TEXT,
    "briefText" TEXT,
    "briefReferences" TEXT,
    "briefAdvanced" TEXT,
    "pendingRefinement" TEXT,
    "detectedQuery" TEXT,
    "queryVariants" TEXT,
    "evidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "generatingAt" DATETIME,
    "queuedAt" DATETIME,
    "wasApproved" BOOLEAN NOT NULL DEFAULT false,
    "reviewedAt" DATETIME,
    "mode" TEXT NOT NULL DEFAULT 'standard',
    "generatedMode" TEXT NOT NULL DEFAULT 'standard',
    "proofPoints" TEXT,
    "personaPriorities" TEXT,
    "conversionPlan" TEXT,
    "v2Plan" TEXT,
    "subtlePlan" TEXT,
    "variantHandle" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Article" ("conversionPlan", "createdAt", "detectedQuery", "errorMessage", "evidence", "generatedMode", "generatingAt", "id", "locale", "mode", "personaPriorities", "productHandle", "productId", "productTitle", "proofPoints", "queryVariants", "queuedAt", "reviewedAt", "shop", "sourceText", "sourceTitle", "sourceUrl", "status", "subtlePlan", "updatedAt", "v2Plan", "variantHandle", "wasApproved") SELECT "conversionPlan", "createdAt", "detectedQuery", "errorMessage", "evidence", "generatedMode", "generatingAt", "id", "locale", "mode", "personaPriorities", "productHandle", "productId", "productTitle", "proofPoints", "queryVariants", "queuedAt", "reviewedAt", "shop", "sourceText", "sourceTitle", "sourceUrl", "status", "subtlePlan", "updatedAt", "v2Plan", "variantHandle", "wasApproved" FROM "Article";
DROP TABLE "Article";
ALTER TABLE "new_Article" RENAME TO "Article";
CREATE UNIQUE INDEX "Article_variantHandle_key" ON "Article"("variantHandle");
CREATE INDEX "Article_shop_productId_locale_idx" ON "Article"("shop", "productId", "locale");
CREATE INDEX "Article_shop_status_idx" ON "Article"("shop", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "VariantVersion_articleId_number_key" ON "VariantVersion"("articleId", "number");

-- Backfill: pasted articles have no sourceUrl; everything else was fetched
-- from its URL and keeps the 'article' default.
UPDATE "Article" SET "sourceKind" = 'pasted' WHERE "sourceUrl" IS NULL;
