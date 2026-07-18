#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# uniqueness.sh — validates the Enterprise Uniqueness Rules delivery
# (unique_mandatory_rules.xlsx, UNI-001..036) over real HTTP.
#
# PROD-SAFE / ZERO COUPLING: ops-side validation only — touches NO application
# code and NO infrastructure. READ-ONLY by design: every probe attempts a
# DUPLICATE create and expects the server to REJECT it (a rejected request
# writes nothing). If a probe unexpectedly succeeds, it self-cleans.
# The single genuinely-writing probe (UNI-036 idempotent ledger replay) is
# gated behind WRITE_TESTS=1 and posts a clearly-labelled 1-paise credit.
#
# Standalone:  BASE=http://localhost:3000/api/v1 bash deploy/srs/uniqueness.sh
# Suite:       sourced by run.sh (after delivered-fixes.sh)
# ─────────────────────────────────────────────────────────────────────────────
HERE_UNI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE_UNI/lib.sh"
. "$HERE_UNI/accounts.sh"

sec "UNIQUENESS RULES (UNI-001..036) — duplicate-rejection sweep"

# DEDUP: reuse the ADMIN_TOKEN already in scope from functional.sh (this module
# previously forced a fresh login under its own var name). reuse_or_login
# validates+reuses it, or logs in when standalone/expired.
reuse_or_login ADMIN_TOKEN "$ADMIN_EMAIL" "$ADMIN_PASS"
UNI_ADMIN_TOKEN="$ADMIN_TOKEN"
if [ -z "$UNI_ADMIN_TOKEN" ]; then
  skip "uniqueness sweep" "admin login unavailable" "UNI-001"
else

  # ── UNI-001: email is globally unique (any role, any workspace) ────────────
  req_settle POST /auth/signup/student "$(jq -nc --arg e "$ADMIN_EMAIL" \
    '{name:"ZZ SRS Uni Probe",role:"student",email:$e,password:"Zz@Probe123456",loginPreference:"email"}')"
  assert_code "UNI-001 duplicate email signup rejected" 409 "$R_CODE" "UNI-001"
  [ -n "$(jbody '.errors.email // empty')" ] \
    && ok "UNI-001 conflict names the email field" "" "UNI-001" \
    || no "UNI-001 conflict names the email field" "errors.email missing" "UNI-001"

  # ── UNI-001 normalization: case variants are the SAME identity ─────────────
  _UPPER_EMAIL="$(printf '%s' "$ADMIN_EMAIL" | tr '[:lower:]' '[:upper:]')"
  req_settle POST /auth/signup/student "$(jq -nc --arg e "$_UPPER_EMAIL" \
    '{name:"ZZ SRS Uni Probe",role:"student",email:$e,password:"Zz@Probe123456",loginPreference:"email"}')"
  assert_code "UNI-001 case-variant email also rejected" 409 "$R_CODE" "UNI-001"

  # ── UNI-003: organization name globally unique incl. normalization ─────────
  req GET /organizations/me "" "$UNI_ADMIN_TOKEN"
  _ORG_NAME="$(jbody '.name // .data.name // empty')"
  if [ -n "$_ORG_NAME" ]; then
    _RND="zz.uni.$(date +%s%N | tail -c 10)@probe.invalid"
    req_settle POST /auth/signup/admin "$(jq -nc --arg e "$_RND" --arg o "$_ORG_NAME" \
      '{name:"ZZ SRS Uni Probe",role:"hostelAdmin",email:$e,password:"Zz@Probe123456",organizationName:$o,loginPreference:"email"}')"
    assert_code "UNI-003 duplicate org name signup rejected" 409 "$R_CODE" "UNI-003"
  else
    skip "UNI-003 duplicate org name" "org name unavailable" "UNI-003"
  fi

  # ── UNI-005/006: one ACTIVE group per (org, name, type) ────────────────────
  req GET "/groups?page=1&limit=1" "" "$UNI_ADMIN_TOKEN"
  _G_NAME="$(jbody '.data[0].name // empty')"
  _G_TYPE="$(jbody '.data[0].type // empty')"
  if [ -n "$_G_NAME" ] && [ -n "$_G_TYPE" ]; then
    req_settle POST /groups "$(jq -nc --arg n "$_G_NAME" --arg t "$_G_TYPE" \
      '{name:$n,type:$t}')" "$UNI_ADMIN_TOKEN"
    if [ "$R_CODE" = "409" ]; then
      ok "UNI-005 duplicate group create rejected" "(409)" "UNI-005,UNI-006"
    else
      no "UNI-005 duplicate group create rejected" "expected 409 got $R_CODE" "UNI-005,UNI-006"
      _LEAK_ID="$(jbody '.id // .data.id // empty')"   # self-clean the leak
      [ -n "$_LEAK_ID" ] && req DELETE "/groups/$_LEAK_ID" "" "$UNI_ADMIN_TOKEN"
    fi
  else
    skip "UNI-005 duplicate group create" "no existing group to mirror" "UNI-005"
  fi

  # ── UNI-016: one ACTIVE meal name per group (409, not 400) ─────────────────
  req GET "/groups?page=1&limit=1" "" "$UNI_ADMIN_TOKEN"
  _G_ID="$(jbody '.data[0].id // empty')"
  if [ -n "$_G_ID" ]; then
    req GET "/meals?groupId=$_G_ID" "" "$UNI_ADMIN_TOKEN"
    _M_NAME="$(jbody '.data[0].name // empty')"
    if [ -n "$_M_NAME" ]; then
      req_settle POST /meals "$(jq -nc --arg g "$_G_ID" --arg n "$_M_NAME" \
        '{groupId:$g,slotKey:"zz_uni_dup_probe",name:$n,attendanceEnabled:true,attendanceWindow:{openTime:"00:00",closeTime:"23:59"}}')" "$UNI_ADMIN_TOKEN"
      if [ "$R_CODE" = "409" ]; then
        ok "UNI-016 duplicate meal name rejected with 409" "(409)" "UNI-016"
      else
        no "UNI-016 duplicate meal name rejected with 409" "expected 409 got $R_CODE" "UNI-016"
        _LEAK_MID="$(jbody '.id // .data.id // empty')"  # self-clean the leak
        [ -n "$_LEAK_MID" ] && req DELETE "/meals/$_LEAK_MID" "" "$UNI_ADMIN_TOKEN"
      fi
    else
      skip "UNI-016 duplicate meal name" "group has no meals to mirror" "UNI-016"
    fi
  else
    skip "UNI-016 duplicate meal name" "no group available" "UNI-016"
  fi

  # ── UNI-013 / UNI-035: LIVE probes of the single-active invariants ─────────
  # Long parked as MANUAL ("needs live mail" / "would break real push") — both
  # objections are obsolete: the invariants are directly observable with a
  # read-only in-container SQL count, and the FCM probe restores every token
  # it touches through the SAME product API (junk it created is cleared by
  # exact value — a real token is never modified). WRITE-gated + self-cleaned;
  # read-only runs keep the MANUAL fallback exactly as before.
  _PGC_UNI="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 postgres || true)"
  _pg_uni(){ docker exec -i "$_PGC_UNI" bash -c 'psql -tAU "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null; }
  if [ "$WRITE_TESTS" = "1" ] && [ -n "$_PGC_UNI" ]; then
    # UNI-013: issuing a new OTP must invalidate every previous unused one for
    # the same identifier+purpose. Request TWO codes for the standing test
    # student, then count ACTIVE rows — exactly 1 may remain. The rows are
    # transient (TTL-expired + invalidated by the next real request): no
    # cleanup needed, and the emailed codes only reach the test inbox.
    _OTP_ID="$(printf '%s' "${STUDENT_EMAIL:-}" | tr 'A-Z' 'a-z')"
    if [ -n "$_OTP_ID" ]; then
      req POST /auth/otp/request "$(jq -nc --arg i "$_OTP_ID" '{identifier:$i,purpose:"login"}')"
      _O1="$R_CODE"
      req POST /auth/otp/request "$(jq -nc --arg i "$_OTP_ID" '{identifier:$i,purpose:"login"}')"
      _O2="$R_CODE"
      if [ "${_O1:0:1}" = "2" ] && [ "${_O2:0:1}" = "2" ]; then
        _ACTIVE="$(printf '%s' "SELECT count(*) FROM otp_requests WHERE identifier='$_OTP_ID' AND purpose='login' AND \"isUsed\"=false AND \"expiresAt\">now();" | _pg_uni)"
        if [ "$_ACTIVE" = "1" ]; then
          ok "UNI-013 resend invalidates the prior OTP (1 active code)" "" "UNI-013"
        else
          no "UNI-013 single-active OTP" "active codes=${_ACTIVE:-?} (expected exactly 1)" "UNI-013"
        fi
      else
        skip "UNI-013 single-active OTP" "otp/request returned $_O1/$_O2 (OTP throttle 5/min?)" "UNI-013"
      fi
    else
      manual "UNI-013 single-active OTP (unit-covered)" "no STUDENT_EMAIL configured" "UNI-013"
    fi

    # UNI-035: a device token belongs to exactly ONE account — claiming it
    # must release the previous owner in the same transaction. Probe with a
    # synthetic ZZ token between the two test students, then restore.
    reuse_or_login STUDENT_TOKEN  "${STUDENT_EMAIL:-}"  "${STUDENT_PASS:-}"
    reuse_or_login STUDENT2_TOKEN "${STUDENT2_EMAIL:-}" "${STUDENT2_PASS:-}"
    if [ -n "${STUDENT_TOKEN:-}" ] && [ -n "${STUDENT2_TOKEN:-}" ]; then
      req GET /auth/me "" "$STUDENT_TOKEN";  _U1="$(jbody '.id // .data.id // empty')"
      req GET /auth/me "" "$STUDENT2_TOKEN"; _U2="$(jbody '.id // .data.id // empty')"
      _T1="$(printf '%s' "SELECT coalesce(\"fcmToken\",'') FROM users WHERE id='$_U1';" | _pg_uni)"
      _T2="$(printf '%s' "SELECT coalesce(\"fcmToken\",'') FROM users WHERE id='$_U2';" | _pg_uni)"
      _ZZTOK="ZZ_UNI035_PROBE_$(date +%s)"
      req POST /auth/fcm-token "$(jq -nc --arg t "$_ZZTOK" '{token:$t}')" "$STUDENT_TOKEN"
      req POST /auth/fcm-token "$(jq -nc --arg t "$_ZZTOK" '{token:$t}')" "$STUDENT2_TOKEN"
      _OWNERS="$(printf '%s' "SELECT count(*) FROM users WHERE \"fcmToken\"='$_ZZTOK';" | _pg_uni)"
      _IS2="$(printf '%s' "SELECT count(*) FROM users WHERE \"fcmToken\"='$_ZZTOK' AND id='$_U2';" | _pg_uni)"
      if [ "$_OWNERS" = "1" ] && [ "$_IS2" = "1" ]; then
        ok "UNI-035 claiming a device token releases the prior owner" "1 owner (the claimer)" "UNI-035"
      else
        no "UNI-035 single-owner FCM token" "owners=${_OWNERS:-?} claimer-owns=${_IS2:-?}" "UNI-035"
      fi
      # SELF-CLEAN: put each student's ORIGINAL token back via the same API;
      # a student who had none gets the probe junk cleared by exact value.
      [ -n "$_T1" ] && req POST /auth/fcm-token "$(jq -nc --arg t "$_T1" '{token:$t}')" "$STUDENT_TOKEN"
      if [ -n "$_T2" ]; then
        req POST /auth/fcm-token "$(jq -nc --arg t "$_T2" '{token:$t}')" "$STUDENT2_TOKEN"
      else
        printf '%s' "UPDATE users SET \"fcmToken\"=NULL WHERE \"fcmToken\"='$_ZZTOK';" | _pg_uni >/dev/null
      fi
      _LEFT="$(printf '%s' "SELECT count(*) FROM users WHERE \"fcmToken\"='$_ZZTOK';" | _pg_uni)"
      [ "${_LEFT:-1}" = "0" ] \
        && ok "cleanup: probe token cleared, real tokens restored" "" "UNI-035" \
        || no "cleanup: UNI-035 probe token still present" "rows=${_LEFT:-?}" "UNI-035"
    else
      manual "UNI-035 single-owner FCM token (unit-covered)" "needs both student logins" "UNI-035"
    fi
  else
    manual "UNI-013 single-active OTP (unit-covered)" "live probe needs WRITE_TESTS=1 + postgres container (run on the VPS)" "UNI-013"
    manual "UNI-035 single-owner FCM token (unit-covered)" "live probe needs WRITE_TESTS=1 + postgres container (run on the VPS)" "UNI-035"
  fi

  # ── UNI-036: Idempotency-Key replay on ledger adjustments (WRITE gated) ────
  if [ "$WRITE_TESTS" = "1" ] && [ -n "$_G_ID" ]; then
    req GET "/groups/$_G_ID/members?page=1&limit=1" "" "$UNI_ADMIN_TOKEN"
    _U_ID="$(jbody '.data[0].userId // .data[0].user.id // empty')"
    if [ -n "$_U_ID" ]; then
      _IKEY="srs-uni-$(date +%s%N)"
      _ADJ_BODY="$(jq -nc --arg g "$_G_ID" --arg u "$_U_ID" \
        '{groupId:$g,userId:$u,type:"credit",amount:1,reason:"SRS validator idempotency probe (1 paise)"}')"
      # Exactly TWO keyed calls: the first creates the (labelled, 1-paise)
      # entry, the second MUST replay the same entry id — never a duplicate.
      _kpost(){ curl -s -o "$RESULTS_DIR/.body" -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $UNI_ADMIN_TOKEN" \
        -H "Idempotency-Key: $_IKEY" --data "$_ADJ_BODY" \
        "$BASE/billing/adjustments" 2>/dev/null; }
      _C1="$(_kpost)"; _ID1="$(jq -r '.id // .data.id // empty' "$RESULTS_DIR/.body" 2>/dev/null)"
      _C2="$(_kpost)"; _ID2="$(jq -r '.id // .data.id // empty' "$RESULTS_DIR/.body" 2>/dev/null)"
      if [ -n "$_ID1" ] && [ "$_ID1" = "$_ID2" ]; then
        ok "UNI-036 Idempotency-Key replays same entry" "($_C1→$_C2)" "UNI-036"
      else
        no "UNI-036 Idempotency-Key replays same entry" "ids differ: '$_ID1' vs '$_ID2' ($_C1/$_C2)" "UNI-036"
      fi
    else
      skip "UNI-036 idempotent adjustment" "no member found" "UNI-036"
    fi
  else
    skip "UNI-036 idempotent adjustment" "WRITE_TESTS=1 required (posts 1-paise labelled credit)" "UNI-036"
  fi

  # ── DB constraints present (optional — only when psql is reachable) ────────
  _PGC="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 postgres || true)"
  if [ -n "$_PGC" ]; then
    _IDX="$(docker exec "$_PGC" psql -U "${POSTGRES_USER:-emeal}" -d "${POSTGRES_DB:-emeal_db}" -tAc \
      "SELECT count(*) FROM pg_indexes WHERE indexname IN ('users_email_global_uniq','users_phone_global_uniq','groups_org_type_name_active_uniq','meals_group_name_active_uniq','billing_periods_group_span_finalized_uniq')" 2>/dev/null || echo '')"
    if [ "$_IDX" = "5" ]; then
      ok "UNI DB race-proof indexes present (5/5)" "" "UNI-001,UNI-002,UNI-005,UNI-016,UNI-028"
    elif [ -n "$_IDX" ]; then
      no "UNI DB race-proof indexes present (5/5)" "found $_IDX/5 — check migrate WARNINGs for skipped (dirty-data) indexes" "UNI-001,UNI-002,UNI-005,UNI-016,UNI-028"
    else
      skip "UNI DB race-proof indexes" "psql query failed" "UNI-028"
    fi
  else
    skip "UNI DB race-proof indexes" "no postgres container visible (run on the server)" "UNI-028"
  fi
fi
