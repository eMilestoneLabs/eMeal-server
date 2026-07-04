#!/bin/bash
# Live-server audit for SRS Passes 11 + 12 + 13 (+ Pass 7 regression).
# Usage:  EMAIL=admin@mail PASS=yourpass bash deploy/audit-pass11-13.sh
# Read-only except: one ₹5 test credit (append-only ledger, offset later if
# desired) and a vacation request that is created, approved, then cancelled.

API="${API:-http://localhost:3000/api/v1}"
EMAIL="${EMAIL:?run as: EMAIL=you@mail PASS=yourpass bash deploy/audit-pass11-13.sh}"
PASS="${PASS:?missing PASS}"
cd "$(dirname "$0")/.." || exit 1

PY='import json,sys
def f(d,k):
  if isinstance(d,dict):
    if k in d and d[k]: return d[k]
    for v in d.values():
      r=f(v,k)
      if r: return r
  if isinstance(d,list):
    for v in d:
      r=f(v,k)
      if r: return r
print(f(json.load(sys.stdin),sys.argv[1]) or "")'

echo "== RELEASE =="
git log --oneline -1

LOGIN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"identifier\":\"$EMAIL\",\"password\":\"$PASS\"}")
TOKEN=$(echo "$LOGIN" | python3 -c "$PY" accessToken)
if [ -z "$TOKEN" ]; then
  echo "LOGIN FAILED — raw response (429 = throttled, wait 60s):"
  echo "$LOGIN" | head -c 300
  exit 1
fi
AH="Authorization: Bearer $TOKEN"

GROUP=$(curl -s "$API/groups" -H "$AH" | python3 -c "$PY" id)
MEMBER=$(curl -s "$API/groups/$GROUP/members?limit=3" -H "$AH" | python3 -c "$PY" userId)
echo "GROUP=$GROUP MEMBER=$MEMBER"

echo "== 1 MIGRATION =="
PGU=$(grep -m1 '^POSTGRES_USER=' .env | cut -d= -f2)
PGD=$(grep -m1 '^POSTGRES_DB=' .env | cut -d= -f2)
docker exec emeal_postgres psql -U "${PGU:-postgres}" -d "${PGD:-emeal_db}" -c \
  "SELECT table_name,column_name FROM information_schema.columns WHERE column_name IN ('vacationRequiresApproval','billingCycleStartDay','startSlotKey','endSlotKey') OR (table_name='billing_ledger_entries' AND column_name IN ('type','amount'));"

echo "== 2 PASS 7 REGRESSION =="
curl -s "$API/groups/$GROUP" -H "$AH" | python3 -c 'import json,sys;g=json.load(sys.stdin);g=g.get("data",g);print("attendanceDefault:",g.get("attendanceDefault"),"| vacReqApproval:",g.get("vacationRequiresApproval"),"| cycleDay:",g.get("billingCycleStartDay"))'
curl -s "$API/billing/periods?groupId=$GROUP" -H "$AH" | head -c 250; echo

echo "== 3 PASS 11 =="
echo "backdate probe (expect 422):"
curl -s -X POST "$API/vacation-requests" -H "$AH" -H 'Content-Type: application/json' \
  -d '{"startDate":"2026-06-01","endDate":"2026-06-05","reason":"backdate probe"}' -o /dev/null -w "%{http_code}\n"
echo "dated request with slots (expect id + slot keys echoed):"
VREQ=$(curl -s -X POST "$API/vacation-requests" -H "$AH" -H 'Content-Type: application/json' \
  -d '{"startDate":"2026-07-15","endDate":"2026-07-17","reason":"audit","startSlotKey":"lunch","endSlotKey":"breakfast"}')
echo "$VREQ" | head -c 250; echo
VID=$(echo "$VREQ" | python3 -c "$PY" id)
echo "approve (expect conflicts[] key in response):"
curl -s -X PATCH "$API/vacation-requests/$VID/approve" -H "$AH" -H 'Content-Type: application/json' -d '{}' | head -c 250; echo
echo "vacation flag today (expect false — future range must not flip today):"
curl -s "$API/users/me" -H "$AH" | grep -o '"isVacationMode":[a-z]*'
echo "policy on (expect 200):"
curl -s -X PATCH "$API/groups/$GROUP" -H "$AH" -H 'Content-Type: application/json' \
  -d '{"mealConfig":{"vacationRequiresApproval":true}}' -o /dev/null -w "%{http_code}\n"
echo "instant toggle under policy (expect 422 refused):"
curl -s -X PATCH "$API/users/me/vacation-mode" -H "$AH" -H 'Content-Type: application/json' \
  -d '{"enabled":true}' -w " -> %{http_code}\n" | tail -1
echo "cleanup policy-off + cancel request (expect 200 200):"
curl -s -X PATCH "$API/groups/$GROUP" -H "$AH" -H 'Content-Type: application/json' \
  -d '{"mealConfig":{"vacationRequiresApproval":false}}' -o /dev/null -w "%{http_code} "
curl -s -X PATCH "$API/vacation-requests/$VID/cancel" -H "$AH" -H 'Content-Type: application/json' -d '{}' -o /dev/null -w "%{http_code}\n"

echo "== 4 PASS 12 =="
echo "summary new fields:"
curl -s "$API/attendance/billing-summary?groupId=$GROUP" -H "$AH" | python3 -c 'import json,sys;s=json.load(sys.stdin);m=s.get("summary",{});print("cycleStartDay:",m.get("cycleStartDay"),"| adjTotal:",m.get("adjustmentsTotal"),"| netRevenue:",m.get("netRevenue"),"| vacDays:",m.get("vacationDays"),"| slots:",len(s.get("slotBreakdown",[])))'
echo "credit (expect 201):"
curl -s -X POST "$API/billing/adjustments" -H "$AH" -H 'Content-Type: application/json' \
  -d "{\"groupId\":\"$GROUP\",\"userId\":\"$MEMBER\",\"type\":\"credit\",\"amount\":500,\"reason\":\"audit credit\"}" -o /dev/null -w "%{http_code}\n"
echo "debit without consent (expect 403 CONSENT_REQUIRED):"
curl -s -X POST "$API/billing/adjustments" -H "$AH" -H 'Content-Type: application/json' \
  -d "{\"groupId\":\"$GROUP\",\"userId\":\"$MEMBER\",\"type\":\"debit\",\"amount\":500,\"reason\":\"debit probe\"}" -w " -> %{http_code}\n" | tail -1
echo "overflow amount (expect 422):"
curl -s -X POST "$API/billing/adjustments" -H "$AH" -H 'Content-Type: application/json' \
  -d "{\"groupId\":\"$GROUP\",\"userId\":\"$MEMBER\",\"type\":\"credit\",\"amount\":99999999999,\"reason\":\"overflow probe\"}" -o /dev/null -w "%{http_code}\n"
echo "ledger list:"
curl -s "$API/billing/adjustments?groupId=$GROUP" -H "$AH" | head -c 350; echo
echo "rollup export (expect 200 + CSV header):"
curl -s "$API/exports/billing?groupId=$GROUP&format=csv&fromDate=2026-07-01&toDate=2026-07-31" -H "$AH" -o /tmp/bill.csv -w "%{http_code}\n"
head -2 /tmp/bill.csv
echo "billing cache version key:"
RP=$(grep -m1 '^REDIS_PASSWORD=' .env | cut -d= -f2)
docker exec emeal_redis redis-cli ${RP:+-a "$RP"} --no-auth-warning --scan --pattern 'bill:ver:*' | head -3

echo "== 5 PERF (authorized; golden <0.2s; runs 2-3 should be cached/faster) =="
for i in 1 2 3; do
  curl -s -o /dev/null -w "billing-summary %{time_total}s\n" "$API/attendance/billing-summary?groupId=$GROUP" -H "$AH"
done
curl -s -o /dev/null -w "meals-today %{time_total}s\n" "$API/meals/today?groupId=$GROUP" -H "$AH"
curl -s -o /dev/null -w "overview %{time_total}s\n" "$API/dashboard/admin/overview" -H "$AH"

echo "== 6 SECURITY =="
curl -s "$API/billing/adjustments?groupId=$GROUP" -o /dev/null -w "no-token %{http_code} (expect 401)\n"
echo -n "unknown group (expect empty data, never rows): "
curl -s "$API/billing/adjustments?groupId=not-a-real-group" -H "$AH" | head -c 200; echo
echo "== DONE =="
