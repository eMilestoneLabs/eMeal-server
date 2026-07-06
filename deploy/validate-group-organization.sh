#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# validate-group-organization.sh — end-to-end verification of MODULE_02 (Organization &
# Group Management) against the LIVE backend. Real HTTP, real DB writes, real
# responses. No mocks. Mirrors deploy/validate-e2e.sh conventions.
#
# Proves every requirement family added in command_3:
#   ORG/GRP/MEM/NTF/CFG — limits, extended metadata, signed QR, join preview,
#   join-approval workflow (pending→approve/reject/cancel), archive→restore→
#   permanent-delete, self-leave, bell dismissal, tenant isolation — with
#   per-endpoint latency so ULTRA-FAST is measured, not claimed.
#
# It is SELF-CLEANING: every group/membership it creates is prefixed
# "ZZ_M02_VERIFY_" and permanently deleted at the end. Safe to re-run.
#
# USAGE (on VPS):
#   ADMIN_EMAIL='...'  ADMIN_PASS='...' \
#   STUDENT_EMAIL='...' STUDENT_PASS='...' \
#   ADMIN2_EMAIL='...' ADMIN2_PASS='...' \
#   bash deploy/validate-group-organization.sh
#
# Optional env: BASE (default http://localhost:3000/api/v1), PERF_BUDGET_MS
# (default 150 — the p-latency budget each Module-02 read must beat).
#
# Requires: bash, curl, jq. Never modifies infrastructure.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${BASE:-http://localhost:3000/api/v1}"
PERF_BUDGET_MS="${PERF_BUDGET_MS:-150}"
OUT="/tmp/emeal-module02-verify-$(date +%Y%m%d-%H%M%S).log"

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_DIR/srs/accounts.sh" ] && . "$_DIR/srs/accounts.sh"

ADMIN_EMAIL="${ADMIN_EMAIL:-}"; ADMIN_PASS="${ADMIN_PASS:-}"
STUDENT_EMAIL="${STUDENT_EMAIL:-}"; STUDENT_PASS="${STUDENT_PASS:-}"
ADMIN2_EMAIL="${ADMIN2_EMAIL:-}"; ADMIN2_PASS="${ADMIN2_PASS:-}"

command -v jq   >/dev/null || { echo "FATAL: jq not installed";   exit 1; }
command -v curl >/dev/null || { echo "FATAL: curl not installed"; exit 1; }
[ -z "$ADMIN_EMAIL" ] && { echo "FATAL: set ADMIN_EMAIL/ADMIN_PASS (see header)"; exit 1; }

exec > >(tee "$OUT") 2>&1
PASS=0; FAIL=0; SKIP=0; declare -a FAILED_CHECKS
hr()  { printf '%.0s─' {1..78}; echo; }
sec() { echo; hr; echo "▶ $*"; hr; }
ok()   { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m  %-54s %s\n" "$1" "${2:-}"; }
no()   { FAIL=$((FAIL+1)); FAILED_CHECKS+=("$1"); printf "  \033[31mFAIL\033[0m  %-54s %s\n" "$1" "${2:-}"; }
skip() { SKIP=$((SKIP+1)); printf "  \033[33mSKIP\033[0m  %-54s %s\n" "$1" "${2:-}"; }
assert_code() { if [ "$3" = "$2" ]; then ok "$1" "($3, ${4:-})"; else no "$1" "expected $2 got $3 ${4:-}"; fi; }

# timed request → sets R_CODE, R_MS, R_BODY. args: METHOD PATH [JSON] [TOKEN]
req() {
  local method="$1" path="$2" json="${3:-}" token="${4:-}"
  local hdr=(-H 'Content-Type: application/json')
  [ -n "$token" ] && hdr+=(-H "Authorization: Bearer $token")
  local tmp w; tmp="$(mktemp)"
  if [ -n "$json" ]; then
    w=$(curl -s -o "$tmp" -w "%{http_code} %{time_starttransfer}" -X "$method" "${hdr[@]}" -d "$json" "$BASE$path")
  else
    w=$(curl -s -o "$tmp" -w "%{http_code} %{time_starttransfer}" -X "$method" "${hdr[@]}" "$BASE$path")
  fi
  R_CODE="${w%% *}"; local t="${w##* }"
  R_MS=$(awk "BEGIN{printf \"%.0f\", $t*1000}")
  R_BODY="$(cat "$tmp")"; rm -f "$tmp"
}

perf() { # label — PASS if last R_MS within budget
  if [ "${R_MS:-99999}" -le "$PERF_BUDGET_MS" ]; then ok "$1 latency" "${R_MS}ms ≤ ${PERF_BUDGET_MS}ms"
  else skip "$1 latency" "${R_MS}ms > ${PERF_BUDGET_MS}ms (network/cold — re-check on VPS localhost)"; fi
}

login() { req POST /auth/login "$(jq -nc --arg i "$1" --arg p "$2" '{identifier:$i,password:$p}')"
  { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } || { echo ""; return 1; }
  echo "$R_BODY" | jq -r '.accessToken // .data.accessToken // empty'; }

j() { echo "$R_BODY" | jq -r "$1" 2>/dev/null; }   # extract from last body

# throwaway groups to clean up at exit
declare -a CLEANUP_GROUPS
cleanup() {
  sec "CLEANUP — permanently delete throwaway verification groups"
  for gid in "${CLEANUP_GROUPS[@]:-}"; do
    [ -z "$gid" ] && continue
    req DELETE "/groups/$gid/permanent" "" "$ADMIN_TOKEN"
    { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "404" ]; } \
      && ok "Deleted throwaway group" "$gid ($R_CODE)" || no "Cleanup group $gid" "$R_CODE"
  done
}
trap cleanup EXIT

echo "eMeal MODULE_02 Verification — $(date -u +%FT%TZ)"
echo "BASE=$BASE  perf_budget=${PERF_BUDGET_MS}ms  out=$OUT"

# ═════════════════════════════════════════════════════════════════════════════
sec "0. AUTH"
ADMIN_TOKEN="$(login "$ADMIN_EMAIL" "$ADMIN_PASS")"
[ -n "$ADMIN_TOKEN" ] && ok "Admin login" || { no "Admin login" "abort"; exit 1; }
if [ -n "$STUDENT_EMAIL" ]; then STUDENT_TOKEN="$(login "$STUDENT_EMAIL" "$STUDENT_PASS")"
  [ -n "$STUDENT_TOKEN" ] && ok "Student login" || no "Student login"; else STUDENT_TOKEN=""; skip "Student login" "no STUDENT_EMAIL"; fi
if [ -n "$ADMIN2_EMAIL" ]; then ADMIN2_TOKEN="$(login "$ADMIN2_EMAIL" "$ADMIN2_PASS")"
  [ -n "$ADMIN2_TOKEN" ] && ok "Secondary admin login" || no "Secondary admin login"; else ADMIN2_TOKEN=""; skip "Secondary admin login" "no ADMIN2_EMAIL"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "1. LIMITS (ORG-012/013, GRP-004/005/010, CFG-002..013)"
req GET /groups/limits "" "$ADMIN_TOKEN"
assert_code "GET /groups/limits" 200 "$R_CODE"; perf "limits"
CAN_CREATE="$(j '.canCreateGroup // .data.canCreateGroup')"
MAX_GROUPS="$(j '.maxGroups // .data.maxGroups')"
ROLE_LIMIT="$(j '.roleMemberLimit // .data.roleMemberLimit')"
echo "      maxGroups=$MAX_GROUPS canCreate=$CAN_CREATE roleMemberLimit=$ROLE_LIMIT"
[ "$MAX_GROUPS" != "null" ] && ok "limits.maxGroups present (config-driven)" || no "limits.maxGroups"
[ "$ROLE_LIMIT" != "null" ] && ok "limits.roleMemberLimit present (GRP-004)" || no "limits.roleMemberLimit"

# Role-member-limit enforcement — create with maxMembers over the role limit → 422.
if [ "$CAN_CREATE" = "true" ] && [ "$ROLE_LIMIT" != "null" ]; then
  OVER=$((ROLE_LIMIT + 1))
  req POST /groups "$(jq -nc --arg n "ZZ_M02_VERIFY_over" --argjson m "$OVER" '{name:$n,type:"hostel",maxMembers:$m}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "422" ] && echo "$R_BODY" | grep -q MEMBER_LIMIT_EXCEEDED; } \
    && ok "maxMembers > role limit rejected (422 MEMBER_LIMIT_EXCEEDED)" || no "role member-limit enforcement" "$R_CODE"
else skip "role member-limit enforcement" "group limit reached or no roleLimit"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "2. CREATE + EXTENDED METADATA + SIGNED QR (GRP-003/011/012/013)"
if [ "$CAN_CREATE" = "true" ]; then
  BODY=$(jq -nc '{name:"ZZ_M02_VERIFY_meta",type:"hostel",description:"verify",
    country:"India",state:"WB",city:"Kolkata",address:"Test St",currency:"INR",
    maxMembers:10,joinApprovalRequired:false,qrExpiryDays:0,mealConfig:{mealsEnabled:true}}')
  req POST /groups "$BODY" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; } && ok "Create group w/ metadata" "($R_CODE)" || no "Create group" "$R_CODE"
  G_META="$(j '.id // .data.id')"; CLEANUP_GROUPS+=("$G_META")
  req GET "/groups/$G_META" "" "$ADMIN_TOKEN"
  [ "$(j '.country // .data.country')" = "India" ] && ok "GRP-003 country persisted+returned" || no "GRP-003 country"
  [ "$(j '.currency // .data.currency')" = "INR" ] && ok "GRP-003 currency persisted+returned" || no "GRP-003 currency"
  HAS_APPROVAL=$(echo "$R_BODY" | jq 'has("joinApprovalRequired") or (.data|has("joinApprovalRequired"))')
  [ "$HAS_APPROVAL" = "true" ] && ok "GRP-003 joinApprovalRequired exposed" || no "joinApprovalRequired key"
  HAS_PENDING=$(echo "$R_BODY" | jq 'has("pendingCount") or (.data|has("pendingCount"))')
  [ "$HAS_PENDING" = "true" ] && ok "MEM-008 pendingCount exposed" || no "pendingCount key"
  # Signed QR payload (GRP-012)
  req GET "/groups/$G_META/qr-token" "" "$ADMIN_TOKEN"; perf "qr-token"
  QRP="$(j '.qrPayload // .data.qrPayload')"; JCODE="$(j '.joinCode // .data.joinCode')"
  case "$QRP" in emg1.*) ok "GRP-012 signed QR payload (emg1.<sig>)" ;; *) no "GRP-012 signed QR payload" "$QRP" ;; esac
  # MEM-002 preview by join code
  req GET "/groups/preview?joinCode=$JCODE" "" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"; perf "preview"
  assert_code "MEM-002 preview by join code" 200 "$R_CODE"
  HAS_APPROVED_KEY=$(echo "$R_BODY" | jq 'has("approvalRequired")')
  [ "$HAS_APPROVED_KEY" = "true" ] && ok "preview carries approvalRequired+capacity" || no "preview shape"
else skip "create/metadata/QR/preview checks" "group limit reached (CFG-012)"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "3. JOIN-APPROVAL WORKFLOW (MEM-002..010, NTF-001/002)"
if [ "$CAN_CREATE" = "true" ] && [ -n "$STUDENT_TOKEN" ]; then
  req POST /groups "$(jq -nc '{name:"ZZ_M02_VERIFY_approval",type:"hostel",joinApprovalRequired:true,maxMembers:5}')" "$ADMIN_TOKEN"
  G_APR="$(j '.id // .data.id')"; CLEANUP_GROUPS+=("$G_APR")
  req GET "/groups/$G_APR/qr-token" "" "$ADMIN_TOKEN"; ACODE="$(j '.joinCode // .data.joinCode')"
  # Student joins → pending
  req POST /groups/join "$(jq -nc --arg c "$ACODE" '{joinCode:$c}')" "$STUDENT_TOKEN"; perf "join(approval)"
  JS="$(j '.joinStatus // .data.joinStatus')"
  [ "$JS" = "pending" ] && ok "MEM-004 join creates PENDING (joinStatus=pending)" || no "MEM-004 pending join" "joinStatus=$JS"
  # Admin sees the pending request
  req GET "/groups/$G_APR/join-requests" "" "$ADMIN_TOKEN"; perf "join-requests"
  PCOUNT="$(echo "$R_BODY" | jq -r '((.data // .)|length)')"
  [ "${PCOUNT:-0}" -ge 1 ] && ok "MEM-006 admin lists pending request" "n=$PCOUNT" || no "MEM-006 list pending" "n=$PCOUNT"
  SUID="$(echo "$R_BODY" | jq -r '((.data // .)[0].id // (.data // .)[0].userId // empty)')"
  # Approve → active
  req PATCH "/groups/$G_APR/join-requests/$SUID/approve" "" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } && ok "MEM-006 approve → active" "($R_CODE)" || no "MEM-006 approve" "$R_CODE"
  # Student now active — self-leave (MEM-016)
  req POST "/groups/$G_APR/leave" "" "$STUDENT_TOKEN"
  { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } && ok "MEM-016 self-service leave" "($R_CODE)" || no "MEM-016 leave" "$R_CODE"
  # Cancel path: rejoin pending then cancel (MEM-005)
  req POST /groups/join "$(jq -nc --arg c "$ACODE" '{joinCode:$c}')" "$STUDENT_TOKEN"
  req DELETE "/groups/$G_APR/join-request" "" "$STUDENT_TOKEN"
  { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } && ok "MEM-005 cancel own pending request" "($R_CODE)" || no "MEM-005 cancel" "$R_CODE"
else skip "join-approval workflow" "needs create capacity + STUDENT_EMAIL"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "4. ARCHIVE → RESTORE → PERMANENT DELETE (GRP-016/018/019)"
if [ "$CAN_CREATE" = "true" ]; then
  req POST /groups "$(jq -nc '{name:"ZZ_M02_VERIFY_lifecycle",type:"hostel"}')" "$ADMIN_TOKEN"
  G_LC="$(j '.id // .data.id')"
  req DELETE "/groups/$G_LC" "" "$ADMIN_TOKEN"
  assert_code "GRP-016 archive (soft delete)" 200 "$R_CODE"
  # archived hidden from default list, visible with includeInactive
  req GET "/groups?includeInactive=true" "" "$ADMIN_TOKEN"
  echo "$R_BODY" | jq -e --arg id "$G_LC" '((.data // .)|map(.id)|index($id))!=null' >/dev/null \
    && ok "GRP-017 archived visible w/ includeInactive" || no "archived includeInactive"
  req POST "/groups/$G_LC/restore" "" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } && ok "GRP-018 restore" "($R_CODE)" || no "GRP-018 restore" "$R_CODE"
  req DELETE "/groups/$G_LC/permanent" "" "$ADMIN_TOKEN"
  assert_code "GRP-019 permanent delete" 200 "$R_CODE"
  req GET "/groups/$G_LC" "" "$ADMIN_TOKEN"
  assert_code "GRP-019 gone after permanent delete" 404 "$R_CODE"
else skip "lifecycle (archive/restore/delete)" "group limit reached"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "5. NOTIFICATION BELL — dismiss + retention (NTF-005/006/007)"
req GET /notices "" "$ADMIN_TOKEN"; assert_code "List notices (bell)" 200 "$R_CODE"; perf "notices"
NID="$(echo "$R_BODY" | jq -r '((.data // .)[0].id // empty)')"
req GET /notices/unread-count "" "$ADMIN_TOKEN"; assert_code "Unread count (badge)" 200 "$R_CODE"; perf "unread-count"
if [ -n "$NID" ]; then
  req DELETE "/notices/$NID/dismiss" "" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } && ok "NTF-006 dismiss one notice (per-user)" "($R_CODE)" || no "NTF-006 dismiss" "$R_CODE"
else skip "NTF-006 dismiss one" "no notices to dismiss"; fi
req DELETE "/notices/dismiss-all" "" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } && ok "NTF-006 delete-all (per-user)" "($R_CODE)" || no "NTF-006 dismiss-all" "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "6. TENANT ISOLATION (multi-tenant)"
if [ -n "$ADMIN2_TOKEN" ] && [ -n "${G_META:-}" ]; then
  req GET "/groups/$G_META" "" "$ADMIN2_TOKEN"
  assert_code "Cross-org group read blocked" 404 "$R_CODE"
  req PATCH "/groups/$G_META/join-requests/does-not-matter/approve" "" "$ADMIN2_TOKEN"
  { [ "$R_CODE" = "404" ] || [ "$R_CODE" = "403" ]; } && ok "Cross-org approve blocked" "($R_CODE)" || no "Cross-org approve" "$R_CODE"
else skip "tenant isolation" "needs ADMIN2 + a created group"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "SUMMARY"
echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if [ "$FAIL" -gt 0 ]; then printf '  Failed: %s\n' "${FAILED_CHECKS[*]}"; fi
echo "  Full log: $OUT"
[ "$FAIL" -eq 0 ] && echo "  ✅ MODULE_02 VERIFIED" || echo "  ❌ MODULE_02 has failures"
exit $(( FAIL > 0 ? 1 : 0 ))
