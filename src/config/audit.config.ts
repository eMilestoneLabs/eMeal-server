import { registerAs } from '@nestjs/config';

/**
 * Audit-trail configuration (million-user scale).
 *
 * Write-side batching (AUDIT_FLUSH_INTERVAL_MS / AUDIT_BUFFER_MAX) is read
 * directly by AuditService (same pattern as AUDIT_HMAC_SECRET); the values
 * here drive the RETENTION sweep so audit_logs stays bounded in production.
 */
export default registerAs('audit', () => ({
  // Rows older than this are purged by the cleanup worker (per org, and for
  // org-less rows directly in the sweep). Compliance-tunable per deployment.
  retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS ?? '180', 10),
  // Sweep cadence in minutes (0 disables). Per-org cleanup jobs are
  // day-deduped, so a smaller interval only affects how soon after midnight
  // the purge fires — 12h is plenty.
  retentionSweepMinutes: parseInt(
    process.env.AUDIT_CLEANUP_SWEEP_MINUTES ?? '720',
    10,
  ),
}));
