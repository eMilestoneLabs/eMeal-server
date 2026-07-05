-- #4: additive audience gate for notices. Default 'all' preserves every
-- existing notice's visibility (everyone in scope). New request-alert notices
-- use 'admins' so only org admins see them in the bell; students never do.
ALTER TABLE "notices" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'all';
