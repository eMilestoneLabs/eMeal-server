#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# minio-reconcile.sh — find (and optionally delete) ORPHAN objects in the image
# bucket: objects that no DB row references. Closes the only storage-waste gap —
# the app deletes the previous object on replace, but that delete is best-effort,
# so a failed delete can leak. This is the safety net. Additive, infra-only.
#
# An object is an orphan when ALL of:
#   • its key is NOT referenced by any DB image column
#       (meals.imageUrl, users.avatarUrl, schedule_entries.imageUrl, organizations.logoUrl)
#   • it is OLDER than ORPHAN_MIN_AGE_DAYS (default 7) — so an object whose DB
#     write is still in flight is never mistaken for an orphan.
#
# SAFETY:
#   • DRY-RUN by default — only lists. Pass --apply (or APPLY=1) to actually delete.
#   • If the DB reference list comes back EMPTY (likely a query failure), it ABORTS
#     without deleting anything — it will never wipe a bucket on a bad query.
#
#   List orphans:   bash deploy/minio-reconcile.sh
#   Delete them:    bash deploy/minio-reconcile.sh --apply
#   Tune age:       ORPHAN_MIN_AGE_DAYS=14 bash deploy/minio-reconcile.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
ENVFILE="$(readlink -f "$APP_DIR/.env" 2>/dev/null || echo "$APP_DIR/.env")"
[ -f "$ENVFILE" ] && { set -a; . "$ENVFILE"; set +a; }

PG_CONTAINER="${PG_CONTAINER:-emeal_postgres}"
PG_USER="${POSTGRES_USER:-emeal}"
PG_DB="${POSTGRES_DB:-emeal_db}"
BUCKET="${MINIO_BUCKET:-emeal-images}"
CDN="${STORAGE_CDN_URL:-}"
ENDP="${MINIO_ENDPOINT:-http://localhost:9000}"
AGE_DAYS="${ORPHAN_MIN_AGE_DAYS:-7}"

# delete only when explicitly asked: `--apply` arg or APPLY=1 in the environment
APPLY="${APPLY:-0}"
[ "${1:-}" = "--apply" ] && APPLY=1

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
REF="$WORK/referenced.txt"; AGED="$WORK/aged.txt"; ORPH="$WORK/orphans.txt"

# ── 1) Collect every key referenced by the DB ────────────────────────────────
# Strip the public-URL prefix(es) so we compare bucket KEYS (org/.../file.ext).
# Base64 / external values simply won't match a key and are ignored.
docker exec -i "$PG_CONTAINER" psql -tA -U "$PG_USER" -d "$PG_DB" -c "
  SELECT \"imageUrl\"  FROM meals             WHERE \"imageUrl\"  IS NOT NULL
  UNION SELECT \"avatarUrl\" FROM users        WHERE \"avatarUrl\" IS NOT NULL
  UNION SELECT \"imageUrl\"  FROM schedule_entries WHERE \"imageUrl\" IS NOT NULL
  UNION SELECT \"logoUrl\"   FROM organizations    WHERE \"logoUrl\"  IS NOT NULL;
" 2>/dev/null \
 | sed -e "s|^${CDN%/}/||" -e "s|^${ENDP%/}/${BUCKET}/||" \
 | grep -E '^org/' | sort -u > "$REF" || true

REF_COUNT="$(wc -l < "$REF" | tr -d ' ')"
echo "==> Referenced objects in DB: $REF_COUNT"
if [ "${REF_COUNT:-0}" -eq 0 ]; then
  echo "❌ ABORT: DB returned 0 referenced image keys — refusing to treat the whole"
  echo "   bucket as orphans. Check DB connectivity / the query before retrying."
  exit 1
fi

# ── 2) List bucket objects older than the age guard ──────────────────────────
docker run --rm --network host --entrypoint /bin/sh \
  -e MK="${MINIO_ACCESS_KEY:-}" -e SK="${MINIO_SECRET_KEY:-}" \
  minio/mc -c "
    mc alias set l http://localhost:9000 \"\$MK\" \"\$SK\" >/dev/null 2>&1 &&
    mc find l/${BUCKET} --older-than ${AGE_DAYS}d 2>/dev/null
" | sed "s|^l/${BUCKET}/||" | grep -E '^org/' | sort -u > "$AGED" || true

AGED_COUNT="$(wc -l < "$AGED" | tr -d ' ')"
echo "==> Bucket objects older than ${AGE_DAYS}d: $AGED_COUNT"

# ── 3) Orphans = aged objects not referenced by the DB ───────────────────────
comm -23 "$AGED" "$REF" > "$ORPH"
ORPH_COUNT="$(wc -l < "$ORPH" | tr -d ' ')"

if [ "${ORPH_COUNT:-0}" -eq 0 ]; then
  echo "✅ No orphan objects. Storage is clean (no waste)."
  exit 0
fi

echo "==> Found $ORPH_COUNT orphan object(s):"
sed 's/^/     /' "$ORPH"

if [ "$APPLY" != "1" ]; then
  echo
  echo "DRY-RUN — nothing deleted. Re-run with --apply to remove the above."
  exit 0
fi

# ── 4) Delete (only with --apply) ────────────────────────────────────────────
echo "==> Deleting $ORPH_COUNT orphan object(s)…"
# feed the key list into a single mc container; rm each under the bucket
docker run --rm --network host --entrypoint /bin/sh \
  -e MK="${MINIO_ACCESS_KEY:-}" -e SK="${MINIO_SECRET_KEY:-}" \
  -e KEYS="$(cat "$ORPH")" -e BUCKET="$BUCKET" \
  minio/mc -c '
    mc alias set l http://localhost:9000 "$MK" "$SK" >/dev/null 2>&1 || exit 1
    echo "$KEYS" | while IFS= read -r k; do
      [ -n "$k" ] || continue
      mc rm "l/$BUCKET/$k" >/dev/null 2>&1 && echo "  removed $k" || echo "  FAILED  $k"
    done'
echo "✅ Reconcile complete. Consider a monthly cron: 0 3 1 * * $APP_DIR/deploy/minio-reconcile.sh --apply"
