-- Articles that are approved at migration time have been live: mark them so
-- a later demotion shows the "Offline - re-approve" state instead of the
-- neutral "Ready to review".
UPDATE "Article" SET "wasApproved" = true WHERE "status" = 'approved';
