-- AlterTable
ALTER TABLE "Override" ADD COLUMN "articleClaims" TEXT;

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
    "detectedQuery" TEXT,
    "queryVariants" TEXT,
    "evidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "metaMode" BOOLEAN NOT NULL DEFAULT false,
    "proofPoints" TEXT,
    "variantHandle" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Article" ("createdAt", "detectedQuery", "errorMessage", "evidence", "id", "locale", "productHandle", "productId", "productTitle", "queryVariants", "shop", "sourceText", "sourceTitle", "sourceUrl", "status", "updatedAt", "variantHandle") SELECT "createdAt", "detectedQuery", "errorMessage", "evidence", "id", "locale", "productHandle", "productId", "productTitle", "queryVariants", "shop", "sourceText", "sourceTitle", "sourceUrl", "status", "updatedAt", "variantHandle" FROM "Article";
DROP TABLE "Article";
ALTER TABLE "new_Article" RENAME TO "Article";
CREATE UNIQUE INDEX "Article_variantHandle_key" ON "Article"("variantHandle");
CREATE INDEX "Article_shop_productId_locale_idx" ON "Article"("shop", "productId", "locale");
CREATE INDEX "Article_shop_status_idx" ON "Article"("shop", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
