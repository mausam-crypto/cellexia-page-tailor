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
