-- AlterTable
ALTER TABLE "Article" ADD COLUMN "cartSyncError" TEXT;
ALTER TABLE "Article" ADD COLUMN "focusFacts" TEXT;
ALTER TABLE "Article" ADD COLUMN "focusPlan" TEXT;
ALTER TABLE "Article" ADD COLUMN "focusTerm" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "paramName" TEXT NOT NULL DEFAULT 'cx',
    "intensity" TEXT NOT NULL DEFAULT 'light',
    "surfaces" TEXT NOT NULL DEFAULT '[]',
    "subtleSettings" TEXT NOT NULL DEFAULT '{}',
    "illustrationSettings" TEXT NOT NULL DEFAULT '{}',
    "servingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "basketRenameEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cartTransformId" TEXT,
    "basketRenameError" TEXT,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("illustrationSettings", "intensity", "paramName", "servingEnabled", "shop", "subtleSettings", "surfaces", "updatedAt") SELECT "illustrationSettings", "intensity", "paramName", "servingEnabled", "shop", "subtleSettings", "surfaces", "updatedAt" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
