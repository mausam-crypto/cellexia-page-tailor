-- AlterTable
ALTER TABLE "Article" ADD COLUMN "reviewedAt" DATETIME;

-- Articles approved under the old approval-gate model were human-reviewed
-- before going live: mark them reviewed so the switch to post-publication
-- review does not flag every existing live variant.
UPDATE "Article" SET "reviewedAt" = CURRENT_TIMESTAMP WHERE "status" = 'approved';
