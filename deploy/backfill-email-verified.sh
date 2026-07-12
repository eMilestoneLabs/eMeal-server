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
# Guard shipped with commit 4e115b5 on 2026-07-12 — anyone created before
# this instant never had a verification step available to them.
CUTOFF="${CUTOFF:-2026-07-12 00:00:00+00}"

STAMP="$(date -u +%Y%m%d_%H%M%S)"
# The affected-ids receipt must live OUTSIDE the repo: writing it next to this
# script (as before) left an untracked file in deploy/, and deploy.sh's
# clean-tree guard then REFUSED the next deploy ("Working tree not clean:
# ?? deploy/backfill-email-verified.*.ids" — observed 2026-07-12 15:11).
OUT_DIR="${BACKFILL_OUT_DIR:-$HOME/backups/backfills}"
mkdir -p "$OUT_DIR" 2>/dev/null || OUT_DIR="/tmp"
OUT="$OUT_DIR/backfill-email-verified.${STAMP}.ids"

# Self-heal: relocate any receipt an OLDER version left inside the repo so it
# stops blocking deploys (harmless if none exist).
for _stray in "$(dirname "$0")"/backfill-email-verified.*.ids; do
  [ -e "$_stray" ] && mv -f "$_stray" "$OUT_DIR/" 2>/dev/null \
    && echo "moved stray receipt out of the repo: $(basename "$_stray") -> $OUT_DIR/"
done

# Credentials are resolved INSIDE the container from its own environment
# (docker-compose.prod.yml takes POSTGRES_USER/POSTGRES_DB from the server
# .env with NO default) — the same proven pattern benchmark-full.sh and
# checklist-190.sh use. Host-side defaults broke here once: the first
# deploy's backfill silently failed on a cred mismatch and every legacy
# account stayed 403-gated. Never pass -U from the host again.
pgexec() {
  docker exec -i "$PG_CONTAINER" bash -c 'psql -v ON_ERROR_STOP=1 -tAU "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

echo "== Legacy email-verification backfill (cutoff: ${CUTOFF}) =="

PENDING="$(printf '%s' "SELECT count(*) FROM users WHERE \"emailVerifiedAt\" IS NULL AND \"createdAt\" < '${CUTOFF}' AND \"deletedAt\" IS NULL;" | pgexec)"
echo "Accounts to grandfather: ${PENDING}"

if [ "${PENDING}" = "0" ]; then
  echo "Nothing to do — all legacy accounts already verified."
  exit 0
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  printf '%s' "SELECT id, email, \"createdAt\" FROM users WHERE \"emailVerifiedAt\" IS NULL AND \"createdAt\" < '${CUTOFF}' AND \"deletedAt\" IS NULL ORDER BY \"createdAt\";" | pgexec
  echo "DRY_RUN=1 — no rows changed."
  exit 0
fi

printf '%s' "UPDATE users SET \"emailVerifiedAt\" = \"createdAt\"
   WHERE \"emailVerifiedAt\" IS NULL AND \"createdAt\" < '${CUTOFF}' AND \"deletedAt\" IS NULL
   RETURNING id;" | pgexec | tee "$OUT"

# Prove the gate is actually open — a wrong container/db would zero-match
# silently otherwise. Any remaining NULL legacy row means the fix did NOT land.
REMAIN="$(printf '%s' "SELECT count(*) FROM users WHERE \"emailVerifiedAt\" IS NULL AND \"createdAt\" < '${CUTOFF}' AND \"deletedAt\" IS NULL;" | pgexec)"
if [ "${REMAIN}" != "0" ]; then
  echo "ERROR: ${REMAIN} legacy account(s) still unverified after the update." >&2
  exit 1
fi

echo "== Done. Affected user ids saved to ${OUT} =="
echo "Participation writes (attendance / corrections / guests / vacations)"
echo "work again for legacy accounts; accounts created after ${CUTOFF}"
echo "still verify through the normal in-app OTP flow (ACC-005)."
