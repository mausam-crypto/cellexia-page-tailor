-- One-time, idempotent backfill for the metaMode/generatedMetaMode -> mode/
-- generatedMode conversion (v1.x "adaptation modes" release).
--
-- Production uses `prisma db push` against Postgres, not `migrate deploy`, so
-- the SQLite migration folder's data-preserving UPDATE never runs here. This
-- script reproduces it directly against Postgres, BEFORE db push drops the
-- old boolean columns, so no existing Meta-mode article silently reverts to
-- "standard". Safe to run on every boot: the IF EXISTS guard makes it a
-- no-op once the old columns are gone (already-converted DB, or a database
-- that never had them).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Article' AND column_name = 'metaMode'
  ) THEN
    ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'standard';
    ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "generatedMode" TEXT NOT NULL DEFAULT 'standard';

    UPDATE "Article" SET
      "mode" = CASE WHEN "metaMode" THEN 'meta' ELSE 'standard' END,
      "generatedMode" = CASE WHEN "generatedMetaMode" THEN 'meta' ELSE 'standard' END;
  END IF;
END $$;

-- One-time, idempotent backfill for the sourceKind column (briefs_and_versions
-- release, 2026-10-21).
--
-- This runs BEFORE `db push`, so on the very first boot after this release
-- the column does not exist yet. This block adds it itself (matching the
-- schema default) and immediately corrects existing pasted articles — which
-- have no sourceUrl — to "pasted" instead of the default "article", before
-- `db push` runs. Safe to run on every boot: the IF NOT EXISTS guard makes
-- it a no-op from the second boot onward, once the column is in place.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Article' AND column_name = 'sourceKind'
  ) THEN
    ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "sourceKind" TEXT NOT NULL DEFAULT 'article';

    UPDATE "Article" SET "sourceKind" = 'pasted' WHERE "sourceUrl" IS NULL;
  END IF;
END $$;
