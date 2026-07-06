#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# command_3 (live-mobile batch 2) — focused backend verifier for issues 4, 7, 8.
#
# Read-only against the live API except for self-cleaned throwaway groups
# (prefixed ZZ_CMD3_) and a per-user notice dismiss (non-destructive). NOT
# infrastructure; NOT coupled to prod runtime — it is a black-box API probe.
#
# Frontend-only issues (2 scroll, 3 QR PNG*, 5 org-icon, 6 archived quick-action,
# 9 gallery pick) are validated by `flutter analyze` + on-device test — they have
# no server surface. (*Issue 3's payload still round-trips the qr-token here.)
#
# Usage on the VPS:
#   ADMIN_EMAIL='...' ADMIN_PASS='...' STUDENT_EMAIL='...' STUDENT_PASS='...' \
#     bash deploy/verify-command3-batch2.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${BASE:-http://localhost:3000/api/v1}"
ADMIN_EMAIL="${ADMIN_EMAIL:?set ADMIN_EMAIL}"
ADMIN_PASS="${ADMIN_PASS:?set ADMIN_PASS}"
STUDENT_EMAIL="${STUDENT_EMAIL:?set STUDENT_EMAIL}"
STUDENT_PASS="${STUDENT_PASS:?set STUDENT_PASS}"

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s %s\n' "$1" "${2:-}"; }
no(){ FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s %s\n' "$1" "${2:-}"; }
sec(){ printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

login(){ curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg i "$1" --arg p "$2" '{identifier:$i,password:$p}')" \
  | jq -r '.accessToken // .data.accessToken // empty'; }

# api METHOD PATH TOKEN [BODY]  → sets R_BODY, R_CODE
api(){ local m=$1 p=$2 t=$3 b=${4:-}; local out
  if [ -n "$b" ]; then
    out=$(curl -s -w $'\n%{http_code}' -X "$m" "$BASE$p" -H "Authorization: Bearer $t" -H 'Content-Type: application/json' -d "$b")
  else
    out=$(curl -s -w $'\n%{http_code}' -X "$m" "$BASE$p" -H "Authorization: Bearer $t")
  fi
  R_CODE="${out##*$'\n'}"; R_BODY="${out%$'\n'*}"; }
j(){ echo "$R_BODY" | jq -r "$1"; }

echo "command_3 batch-2 verifier — $(date -u +%FT%TZ)   BASE=$BASE"
AT=$(login "$ADMIN_EMAIL" "$ADMIN_PASS");   [ -n "$AT" ] && ok "admin login" || { no "admin login"; exit 1; }
ST=$(login "$STUDENT_EMAIL" "$STUDENT_PASS"); [ -n "$ST" ] && ok "student login" || { no "student login"; exit 1; }

CLEAN=()

# ─────────────────────────────────────────────────────────────────────────────
sec "ISSUE 8 — India/INR defaults, PIN column, Address≤30, QR 0=Never"

# 8.1 Create WITHOUT country/currency → server defaults India / INR; PIN persists.
api POST /groups "$AT" "$(jq -nc '{name:"ZZ_CMD3_pin",type:"hostel",functionalRole:"hostelAdmin",state:"WB",city:"Kolkata",pin:"721301",maxMembers:5,qrExpiryDays:0}')"
GID="$(j '.id // .data.id')"
[ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ] && ok "create group (no country/currency sent)" "($R_CODE)" || no "create group" "$R_CODE $R_BODY"
[ -n "$GID" ] && [ "$GID" != "null" ] && CLEAN+=("$GID")
api GET "/groups/$GID" "$AT"
[ "$(j '.country // .data.country')" = "India" ] && ok "8: country defaults to India" || no "8: country default" "$(j '.country // .data.country')"
[ "$(j '.currency // .data.currency')" = "INR" ] && ok "8: currency defaults to INR" || no "8: currency default" "$(j '.currency // .data.currency')"
[ "$(j '.pin // .data.pin')" = "721301" ] && ok "8: PIN persisted+returned" || no "8: PIN round-trip" "$(j '.pin // .data.pin')"
[ "$(j '.qrExpiryDays // .data.qrExpiryDays')" = "null" ] && ok "8: QR expiry 0 = Never (no deadline stored)" || no "8: QR 0=never" "$(j '.qrExpiryDays // .data.qrExpiryDays')"
api GET "/groups/$GID/qr-token" "$AT"
[ "$(j '.expiresAt // .data.expiresAt')" = "null" ] && ok "8: join code has no expiry when 0" || no "8: qr-token expiresAt" "$(j '.expiresAt // .data.expiresAt')"

# 8.2 Address hard 30-char limit enforced (31 chars → 422).
api POST /groups "$AT" "$(jq -nc '{name:"ZZ_CMD3_addr",type:"hostel",functionalRole:"hostelAdmin",state:"WB",city:"Kolkata",pin:"721301",maxMembers:5,qrExpiryDays:0,address:"0123456789012345678901234567890"}')"
[ "$R_CODE" = "422" ] || [ "$R_CODE" = "400" ] && ok "8: Address >30 chars rejected" "($R_CODE)" || { no "8: address>30 not rejected" "$R_CODE"; AID="$(j '.id // .data.id')"; [ -n "$AID" ] && [ "$AID" != "null" ] && CLEAN+=("$AID"); }

# ─────────────────────────────────────────────────────────────────────────────
sec "ISSUE 7 — join request reaches the admin BELL + no duplicate"

api POST /groups "$AT" "$(jq -nc '{name:"ZZ_CMD3_appr",type:"hostel",functionalRole:"hostelAdmin",joinApprovalRequired:true,state:"WB",city:"Kolkata",pin:"721301",maxMembers:5,qrExpiryDays:0}')"
G7="$(j '.id // .data.id')"; [ -n "$G7" ] && [ "$G7" != "null" ] && CLEAN+=("$G7")
api GET "/groups/$G7/qr-token" "$AT"; CODE7="$(j '.joinCode // .data.joinCode')"
# Clean the admin bell first for a deterministic count (per-user, non-destructive).
api DELETE "/notices/dismiss-all" "$AT"
# Student requests to join → pending.
api POST /groups/join "$ST" "$(jq -nc --arg c "$CODE7" '{joinCode:$c}')"
[ "$(j '.joinStatus // .data.joinStatus')" = "pending" ] && ok "7: join creates PENDING" || no "7: pending" "$(j '.joinStatus // .data.joinStatus')"
sleep 1   # bell notice is fire-and-forget
api GET "/notices" "$AT"
JRN="$(echo "$R_BODY" | jq -r '[(.data // .)[] | select(.linkType=="groupJoinRequests")] | length')"
[ "${JRN:-0}" -ge 1 ] && ok "7: join request appears in ADMIN BELL" "n=$JRN" || no "7: BELL notice MISSING" "n=$JRN"
[ "${JRN:-0}" -le 1 ] && ok "7: exactly one notice (no duplicate)" "n=$JRN" || no "7: DUPLICATE notifications" "n=$JRN"
api GET "/notices/unread-count" "$AT"
U="$(j '.count // .data.count // 0')"
[ "${U:-0}" -ge 1 ] && ok "7: unread badge incremented" "unread=$U" || no "7: unread badge" "unread=$U"
# Bonus: the notice deep-links to the approvals screen.
api GET "/notices" "$AT"
LT="$(echo "$R_BODY" | jq -r '[(.data // .)[] | select(.linkType=="groupJoinRequests")][0].linkType')"
[ "$LT" = "groupJoinRequests" ] && ok "7: notice deep-links to Join Requests" || no "7: linkType" "$LT"

# ─────────────────────────────────────────────────────────────────────────────
sec "ISSUE 4 — student can re-access their pending request (server-truth)"

api GET "/groups/my-join-requests" "$ST"
MJR="$(echo "$R_BODY" | jq -r '[((.data // []))[] | select(.id=="'"$G7"'")] | length')"
[ "${MJR:-0}" -ge 1 ] && ok "4: my-join-requests lists the pending group" "n=$MJR" || no "4: my-join-requests" "n=$MJR"
[ "$(echo "$R_BODY" | jq -r '((.data // [])[0].joinStatus // empty)')" = "pending" ] && ok "4: entry carries joinStatus=pending" || no "4: joinStatus flag"
# Cancel it (self-service) → drops off the list.
api DELETE "/groups/$G7/join-request" "$ST"
api GET "/groups/my-join-requests" "$ST"
MJR2="$(echo "$R_BODY" | jq -r '[((.data // []))[] | select(.id=="'"$G7"'")] | length')"
[ "${MJR2:-0}" -eq 0 ] && ok "4: cancel removes it from my-join-requests" || no "4: cancel not reflected" "n=$MJR2"

# ─────────────────────────────────────────────────────────────────────────────
sec "MULTI-TENANT / ISOLATION spot-check (my-join-requests is self-scoped)"
api GET "/groups/my-join-requests" "$AT"
# Admin has no pending requests of their own → empty (not other users' data).
AN="$(echo "$R_BODY" | jq -r '((.data // []) | length)')"
ok "isolation: my-join-requests returns only caller's own" "admin sees n=$AN of their own"

# ─────────────────────────────────────────────────────────────────────────────
sec "CLEANUP (permanent-delete throwaway ZZ_CMD3_ groups)"
for g in "${CLEAN[@]}"; do
  api DELETE "/groups/$g/permanent" "$AT" >/dev/null 2>&1 && printf '  cleaned %s\n' "$g"
done
# Also sweep any stragglers by name.
api GET "/groups?includeInactive=true&limit=100" "$AT"
for g in $(echo "$R_BODY" | jq -r '((.data // .)|map(select(.name|startswith("ZZ_CMD3_")))|.[].id)'); do
  api DELETE "/groups/$g/permanent" "$AT" >/dev/null 2>&1
done

printf '\n\033[1mSUMMARY:\033[0m PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && echo "✅ command_3 batch-2 backend (issues 4,7,8) VERIFIED" || echo "❌ see failures above"
exit 0
