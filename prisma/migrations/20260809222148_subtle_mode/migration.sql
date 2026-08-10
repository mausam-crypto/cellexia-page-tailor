-- AlterTable
ALTER TABLE "Article" ADD COLUMN "subtlePlan" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "paramName" TEXT NOT NULL DEFAULT 'cx',
    "intensity" TEXT NOT NULL DEFAULT 'light',
    "surfaces" TEXT NOT NULL DEFAULT '[]',
    "subtleSettings" TEXT NOT NULL DEFAULT '{}',
    "servingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("intensity", "paramName", "servingEnabled", "shop", "surfaces", "updatedAt") SELECT "intensity", "paramName", "servingEnabled", "shop", "surfaces", "updatedAt" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
