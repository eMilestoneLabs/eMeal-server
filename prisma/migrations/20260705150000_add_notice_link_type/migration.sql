-- Notification Center deep-link (command_3): additive nullable column.
-- When set, tapping the notice opens the related approval workflow directly.
-- Values map to a Flutter screen (e.g. vacationRequests | correctionRequests).
ALTER TABLE "notices" ADD COLUMN "linkType" TEXT;
