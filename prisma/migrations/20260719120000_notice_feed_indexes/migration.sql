-- Perf (production scale): composite indexes for the two hottest notice paths.
-- 1. Bell feed + unread-count: filter on (organizationId, isActive) with
--    ORDER BY publishedAt DESC — the sort is served straight from the index
--    (no sort step) at any table size.
-- 2. Live-Test-11 collapsible-alert lookup (findCollapsibleAlert): narrows by
--    organizationId + createdBy + publishedAt >= collapse-window.
-- Additive + idempotent — no data change, read-only impact.
CREATE INDEX IF NOT EXISTS "notices_organizationId_isActive_publishedAt_idx"
  ON "notices"("organizationId", "isActive", "publishedAt" DESC);
CREATE INDEX IF NOT EXISTS "notices_organizationId_createdBy_publishedAt_idx"
  ON "notices"("organizationId", "createdBy", "publishedAt");
