#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# benchmark-endpoints.sh — per-endpoint TTFB benchmark against the LOCAL backend.
#
# Runs ON the VPS against http://localhost:3000 so it isolates *backend compute*
# (no client↔server network in the path). This is the evidence to validate each
# optimization: min_ms ≈ warm/cached, max_ms ≈ cold/cache-miss.
#
#   BENCH_TOKEN=<JWT> bash deploy/benchmark-endpoints.sh
#
# Get a JWT (any logged-in user; admin token also exercises /dashboard/admin):
#   curl -s -X POST http://localhost:3000/api/v1/auth/login \
#     -H 'Content-Type: application/json' \
#     -d '{"identifier":"you@example.com","password":"YOURPASS"}' | jq -r .accessToken
#
# Optional env: BASE, SAMPLES (default 8), GROUP_ID, FROM, TO, IMAGE_URL
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
BASE="${BASE:-http://localhost:3000/api/v1}"
TOKEN="${BENCH_TOKEN:-}"
SAMPLES="${SAMPLES:-8}"
FROM="${FROM:-$(date -d '-7 days' +%F 2>/dev/null || date +%F)}"
TO="${TO:-$(date +%F)}"

if [ -z "$TOKEN" ]; then
  echo "Set BENCH_TOKEN=<JWT>. See the header of this script for how to get one."
  exit 1
fi

# Endpoints to measure (GET only; the hot read paths the app opens).
endpoints=(
  "/dashboard/student"
  "/dashboard/admin"
  "/attendance/today"
  "/attendance/history?fromDate=$FROM&toDate=$TO"
  "/attendance/weekly-summary"
  "/attendance/billing-summary?fromDate=$FROM&toDate=$TO"
  "/attendance/billing-series?fromDate=$FROM&toDate=$TO"
  "/schedules"
  "/meals"
  "/meals/today"
  "/meals/weekly-schedule"
  "/reports/analytics?fromDate=$FROM&toDate=$TO"
  "/exports/attendance?fromDate=$FROM&toDate=$TO"
)

echo "Backend compute benchmark (localhost, $SAMPLES samples each) — TTFB in ms"
printf "%-44s %-6s %-8s %-8s %-8s\n" "endpoint" "code" "min" "avg" "max"
printf '%.0s─' {1..78}; echo
for path in "${endpoints[@]}"; do
  total=0; min=99999; max=0; code=000
  for _ in $(seq 1 "$SAMPLES"); do
    out=$(curl -s -o /dev/null -w "%{http_code} %{time_starttransfer}" \
            -H "Authorization: Bearer $TOKEN" "$BASE$path")
    code="${out%% *}"; t="${out##* }"
    ms=$(awk "BEGIN{printf \"%.0f\", $t*1000}")
    total=$((total + ms))
    [ "$ms" -lt "$min" ] && min=$ms
    [ "$ms" -gt "$max" ] && max=$ms
  done
  avg=$((total / SAMPLES))
  printf "%-44s %-6s %-8s %-8s %-8s\n" "${path%%\?*}" "$code" "$min" "$avg" "$max"
done

# Optional: image (CDN) fetch timing — pass an actual image URL from GET /meals.
if [ -n "${IMAGE_URL:-}" ]; then
  echo
  echo "Image fetch ($IMAGE_URL):"
  curl -s -o /dev/null -w "  http=%{http_version} code=%{http_code} size=%{size_download}B ttfb=%{time_starttransfer}s total=%{time_total}s\n" "$IMAGE_URL"
fi

echo
echo "Interpretation: TTFB here is pure backend compute (localhost). If these are"
echo "small (tens of ms), the user-felt slowness is the France↔India network, which"
echo "the frontend cache-first layer (item 2) hides by rendering last data instantly."
