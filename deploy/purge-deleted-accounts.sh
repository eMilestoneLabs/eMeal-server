#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# purge-deleted-accounts.sh — ONE-TIME cleanup for Live-Test-5 ISSUE-1.
#
# Before 2026-07-16 account deletion anonymized the user row in place
# (deletedAt set, isActive=false, name='Deleted User'). Those legacy rows —
# and any pre-UNI-002 duplicate rows that kept a phone/email — can still hold
# an identifier hostage so the owner cannot sign up again ("This mobile
# number already has a ... account").
#
# The new code hard-purges on delete; this script applies the SAME purge to
# rows already soft-deleted. It NEVER touches active accounts.
#
# Usage (on the VPS, from the repo root):
#   bash deploy/purge-deleted-accounts.sh           # dry run — lists targets
#   CONFIRM=1 bash deploy/purge-deleted-accounts.sh # actually purge
#
# Reads DATABASE_URL from the production .env (same pattern as
# backfill-email-verified.sh). Purely additive ops tooling — no app change.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "FATAL: $ENV_FILE not found (run from repo root on the server)"; exit 1; }
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')"
[ -n "$DATABASE_URL" ] || { echo "FATAL: DATABASE_URL missing in $ENV_FILE"; exit 1; }

SEL="SELECT id, name, email, phone, role, \"deletedAt\" FROM users WHERE \"deletedAt\" IS NOT NULL AND \"isActive\" = false"

echo "── Legacy soft-deleted accounts still present:"
psql "$DATABASE_URL" -c "$SEL;"

echo "── DIAGNOSTIC: inactive rows still HOLDING an email/phone (these are what"
echo "   block re-signup — e.g. admin-removed members; review before purging):"
psql "$DATABASE_URL" -c "SELECT id, name, email, phone, role, \"isActive\", \"deletedAt\" FROM users WHERE \"isActive\" = false AND (email IS NOT NULL OR phone IS NOT NULL);"

if [ "${CONFIRM:-0}" != "1" ]; then
  echo
  echo "Dry run only. Re-run with CONFIRM=1 to hard-purge the rows above"
  echo "(attendance, billing ledger, guests, requests, audit, OTPs, then the user row)."
  exit 0
fi

psql "$DATABASE_URL" <<'SQL'
BEGIN;

CREATE TEMP TABLE _purge_ids AS
  SELECT id, email, phone FROM users
  WHERE "deletedAt" IS NOT NULL AND "isActive" = false;

DELETE FROM refresh_tokens                     WHERE "userId"     IN (SELECT id FROM _purge_ids);
DELETE FROM otp_requests                       WHERE "userId"     IN (SELECT id FROM _purge_ids)
   OR identifier IN (SELECT email FROM _purge_ids WHERE email IS NOT NULL)
   OR identifier IN (SELECT phone FROM _purge_ids WHERE phone IS NOT NULL);
DELETE FROM attendance_correction_requests     WHERE "userId"     IN (SELECT id FROM _purge_ids);
DELETE FROM vacation_requests                  WHERE "userId"     IN (SELECT id FROM _purge_ids);
DELETE FROM notice_reads                       WHERE "userId"     IN (SELECT id FROM _purge_ids);
DELETE FROM meal_guests                        WHERE "hostUserId" IN (SELECT id FROM _purge_ids);
DELETE FROM billing_ledger_entries             WHERE "userId"     IN (SELECT id FROM _purge_ids);
DELETE FROM attendance_records                 WHERE "userId"     IN (SELECT id FROM _purge_ids);
UPDATE attendance_records SET "markedBy" = NULL WHERE "markedBy"  IN (SELECT id FROM _purge_ids);
DELETE FROM events                             WHERE "adminId"    IN (SELECT id FROM _purge_ids);
DELETE FROM group_members                      WHERE "userId"     IN (SELECT id FROM _purge_ids);
UPDATE groups SET "adminId" = NULL              WHERE "adminId"   IN (SELECT id FROM _purge_ids);
DELETE FROM audit_logs                         WHERE "actorId"    IN (SELECT id FROM _purge_ids)
                                                  OR "targetId"   IN (SELECT id FROM _purge_ids);
DELETE FROM users                              WHERE id           IN (SELECT id FROM _purge_ids);

COMMIT;
SQL

echo "── Done. Remaining soft-deleted rows (should be zero):"
psql "$DATABASE_URL" -c "SELECT count(*) FROM users WHERE \"deletedAt\" IS NOT NULL;"
