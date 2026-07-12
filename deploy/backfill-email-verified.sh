#!/usr/bin/env bash
# backfill-email-verified.sh — one-time legacy-account grandfather for the
# SRS Module 03 ACC-005 participation gate (EmailVerifiedGuard).
#
# WHY: the guard (deployed 2026-07-12, commit 4e115b5) blocks attendance
# marking, corrections, guest booking and vacation requests with 403
# EMAIL_VERIFICATION_REQUIRED for any user whose emailVerifiedAt is NULL.
# The column was added 2026-07-01 with NO backfill, so every account created
# before then — i.e. the entire existing member base — is "unverified" and
# every participation tap fails. New signups verify via the in-flow OTP, so
# only legacy rows need this.
#
# WHAT: stamps emailVerifiedAt = createdAt for accounts that predate the
# guard's deployment and are still NULL. Accounts created after the cutoff
# are left untouched — they go through the normal OTP flow (ACC-005 intact).
#
# Idempotent: re-runs match zero rows. Reversible: the audit line printed at
# the end lists affected ids (also saved next to this script).
#
# Usage (on the VPS):   bash deploy/backfill-email-verified.sh
# Dry run:              DRY_RUN=1 bash deploy/backfill-email-verified.sh

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-emeal_postgres}"
POSTGRES_USER="${POSTGRES_USER:-emeal}"
POSTGRES_DB="${POSTGRES_DB:-emeal_db}"
# Guard shipped with commit 4e115b5 on 2026-07-12 — anyone created before
# this instant never had a verification step available to them.
CUTOFF="${CUTOFF:-2026-07-12 00:00:00+00}"

STAMP="$(date -u +%Y%m%d_%H%M%S)"
OUT="$(dirname "$0")/backfill-email-verified.${STAMP}.ids"

echo "== Legacy email-verification backfill (cutoff: ${CUTOFF}) =="

PENDING="$(docker exec "$PG_CONTAINER" psql -tAU "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT count(*) FROM users WHERE \"emailVerifiedAt\" IS NULL AND \"createdAt\" < '${CUTOFF}' AND \"deletedAt\" IS NULL;")"
echo "Accounts to grandfather: ${PENDING}"

if [ "${PENDING}" = "0" ]; then
  echo "Nothing to do — all legacy accounts already verified."
  exit 0
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  docker exec "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
    "SELECT id, email, \"createdAt\" FROM users WHERE \"emailVerifiedAt\" IS NULL AND \"createdAt\" < '${CUTOFF}' AND \"deletedAt\" IS NULL ORDER BY \"createdAt\";"
  echo "DRY_RUN=1 — no rows changed."
  exit 0
fi

docker exec "$PG_CONTAINER" psql -tAU "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "UPDATE users SET \"emailVerifiedAt\" = \"createdAt\"
   WHERE \"emailVerifiedAt\" IS NULL AND \"createdAt\" < '${CUTOFF}' AND \"deletedAt\" IS NULL
   RETURNING id;" | tee "$OUT"

echo "== Done. Affected user ids saved to ${OUT} =="
echo "Participation writes (attendance / corrections / guests / vacations)"
echo "work again for legacy accounts; accounts created after ${CUTOFF}"
echo "still verify through the normal in-app OTP flow (ACC-005)."
