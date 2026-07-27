-- Three adaptation modes replace the meta-mode boolean:
-- "standard" | "meta" | "ultra". Existing meta-mode articles keep their
-- behavior via the backfill before the old columns are dropped.
ALTER TABLE "Article" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "Article" ADD COLUMN "generatedMode" TEXT NOT NULL DEFAULT 'standard';

UPDATE "Article" SET
  "mode" = CASE WHEN "metaMode" THEN 'meta' ELSE 'standard' END,
  "generatedMode" = CASE WHEN "generatedMetaMode" THEN 'meta' ELSE 'standard' END;

ALTER TABLE "Article" DROP COLUMN "metaMode";
ALTER TABLE "Article" DROP COLUMN "generatedMetaMode";
