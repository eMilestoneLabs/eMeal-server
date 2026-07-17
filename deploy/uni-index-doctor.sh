#!/usr/bin/env bash
# uni-index-doctor.sh — Live-Test-7 ISSUE-007: the uniqueness migration
# (20260714120000) guards each race-proof UNIQUE index and SKIPS it with a
# WARNING when live rows already violate the rule. The SRS probe then reports
# "UNI DB race-proof indexes present found 4/5". This doctor names WHICH index
# is missing and prints the exact duplicate rows blocking it, so they can be
# resolved deliberately (never auto-deleted — billing/attendance history may
# hang off either duplicate).
#
# Read-only by default. After cleaning the printed duplicates, re-apply the
# guarded blocks (idempotent) with:  bash deploy/uni-index-doctor.sh --fix
#
# Usage (on the VPS):   bash deploy/uni-index-doctor.sh [--fix]

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-emeal_postgres}"
# Live-Test-8 ISSUE-008: resolve credentials from the CONTAINER's own env
# (same pattern as run.sh's db module) — the hardcoded 'emeal' default
# aborted with `FATAL: database "emeal" does not exist` on servers whose DB
# uses a different name (unidoctor exit=2 in the audit report).
PG_USER="${PG_USER:-$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER 2>/dev/null || echo emeal)}"
PG_DB="${PG_DB:-$(docker exec "$PG_CONTAINER" printenv POSTGRES_DB 2>/dev/null || echo emeal)}"
MIGRATION="$(dirname "$0")/../prisma/migrations/20260714120000_uniqueness_audit_constraints/migration.sql"

psql_ro() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -X -q -t -A -F' | ' -c "$1"; }

declare -A DUP_QUERY=(
  [users_email_global_uniq]="SELECT lower(email), count(*), string_agg(id, ', ') FROM users WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1"
  [users_phone_global_uniq]="SELECT phone, count(*), string_agg(id, ', ') FROM users WHERE phone IS NOT NULL GROUP BY 1 HAVING count(*) > 1"
  [groups_org_type_name_active_uniq]="SELECT \"organizationId\", type, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')), count(*), string_agg(id, ', ') FROM groups WHERE \"isActive\" = true GROUP BY 1,2,3 HAVING count(*) > 1"
  [meals_group_name_active_uniq]="SELECT \"groupId\", lower(regexp_replace(btrim(name), '\s+', ' ', 'g')), count(*), string_agg(id, ', ') FROM meals WHERE \"isActive\" = true GROUP BY 1,2 HAVING count(*) > 1"
  [billing_periods_group_span_finalized_uniq]="SELECT \"groupId\", \"periodStart\", \"periodEnd\", count(*), string_agg(id, ', ') FROM billing_periods WHERE status = 'finalized' GROUP BY 1,2,3 HAVING count(*) > 1"
)

MISSING=0
for idx in users_email_global_uniq users_phone_global_uniq \
           groups_org_type_name_active_uniq meals_group_name_active_uniq \
           billing_periods_group_span_finalized_uniq; do
  present="$(psql_ro "SELECT count(*) FROM pg_indexes WHERE indexname = '$idx'")"
  if [ "$present" = "1" ]; then
    echo "  OK    $idx"
    continue
  fi
  MISSING=$((MISSING + 1))
  echo "  MISS  $idx — duplicate rows blocking it:"
  rows="$(psql_ro "${DUP_QUERY[$idx]}")"
  if [ -z "$rows" ]; then
    echo "        (no duplicates found NOW — safe to re-apply: --fix)"
  else
    echo "$rows" | sed 's/^/        /'
  fi
done

if [ "$MISSING" -eq 0 ]; then
  echo "All 5 race-proof indexes present — nothing to do."
  exit 0
fi

if [ "${1:-}" = "--fix" ]; then
  echo "── Re-applying guarded index blocks (idempotent; still skips dirty rules) ──"
  docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -X -q < "$MIGRATION"
  STILL="$(psql_ro "SELECT 5 - count(*) FROM pg_indexes WHERE indexname IN ('users_email_global_uniq','users_phone_global_uniq','groups_org_type_name_active_uniq','meals_group_name_active_uniq','billing_periods_group_span_finalized_uniq')")"
  if [ "$STILL" = "0" ]; then
    echo "── FIXED — all 5 race-proof indexes present ──"
    exit 0
  fi
  echo "── $STILL index(es) still skipped (dirty rows remain) — re-run without --fix to see them ──"
  exit 1
else
  echo "Resolve the duplicates above (merge/rename/archive — NEVER blind-delete),"
  echo "then re-apply the guarded blocks with:  bash deploy/uni-index-doctor.sh --fix"
  # Audit semantics (run.sh module): missing indexes = attention required.
  exit 1
fi
