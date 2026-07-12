-- Million-user audit-trail scale: composite index serving the two hot access
-- paths — integrity verification (organizationId + ORDER BY createdAt DESC)
-- and the retention purge (organizationId + createdAt < cutoff).
-- Additive only; existing single-column indexes are untouched.
CREATE INDEX "audit_logs_organizationId_createdAt_idx" ON "audit_logs"("organizationId", "createdAt");
