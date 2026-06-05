#!/usr/bin/env bash
#
# scripts/ci/governance-scan.sh
#
# Static governance + secret scan for CI Stage 1. No build/deps required.
# Each check fails the job (exit 1) on a governance violation so a contract or
# security regression is blocked before merge.
set -euo pipefail

fail() { echo "❌ $1"; exit 1; }
ok()   { echo "✅ $1"; }

# 1. No console.log in production source (use LoggerService)
if grep -rn "console\.log" src/ --include="*.ts" | grep -v "\.spec\.ts" >/dev/null; then
  grep -rn "console\.log" src/ --include="*.ts" | grep -v "\.spec\.ts" || true
  fail "console.log found in src/ — use LoggerService"
fi
ok "No console.log in production source"

# 2. WebSocket events must be versioned (.v1 suffix)
grep -rq "\.v1" src/realtime/ || fail "No versioned (.v1) WebSocket events found"
ok "Versioned WebSocket events present"

# 3. Pagination contract — forbidden response keys
if grep -rn '"items"\|"results"\|"pageSize"' src/features/ --include="*.ts" | grep -v "\.spec\.ts" >/dev/null; then
  fail "Forbidden pagination key (items/results/pageSize) — must use data/total/page/limit"
fi
ok "Pagination contract keys clean"

# 4. Meal slots must stay dynamic — no MealType enum
grep -rn "enum MealType" src/ >/dev/null && fail "MealType enum detected — slots must be free-form slotKey" || true
ok "No MealType enum (slotKey governance preserved)"

# 5. Event types must stay free-form — no EventType enum
grep -rn "enum EventType" src/ >/dev/null && fail "EventType enum detected — event types must be free-form" || true
ok "No EventType enum"

# 6. organizationId must never be accepted from request body (JWT-only)
if grep -rn "organizationId" src/features/*/dto/ >/dev/null 2>&1; then
  grep -rn "organizationId" src/features/*/dto/ || true
  fail "organizationId found in a DTO — must come from JWT, never the client"
fi
ok "organizationId absent from DTOs (multi-tenant isolation)"

# 7. No raw Prisma returned from controllers
if grep -rn "return.*prisma\." src/features/ --include="*.controller.ts" >/dev/null 2>&1; then
  fail "Raw Prisma returned from a controller — use serializers"
fi
ok "No raw Prisma leakage in controllers"

# 8. Hardcoded secret heuristic (assignment of a literal to secret/password/apiKey)
MATCHES=$(grep -rn "secret\|password\|apiKey" src/ --include="*.ts" \
  | grep -v "process\.env" \
  | grep -v "config\.get\|configService\|ConfigService" \
  | grep -v "passwordHash\|password_hash\|hashedPassword" \
  | grep -v "bcrypt\|argon2\|crypto\." \
  | grep -v "dto\.\|@IsString\|@MinLength\|@MaxLength\|@IsEmail\|@Matches" \
  | grep -v "errors:\|message:\|statusCode:\|description:" \
  | grep -v "interface \|type \|extends \|implements " \
  | grep -v "\/\/\| \* \|\/\*" \
  | grep -v "test\|spec\|mock\|fixture\|stub" \
  | grep "=\s*['\"][^'\"\$]" \
  || true)
if [ -n "$MATCHES" ]; then
  echo "$MATCHES"
  fail "Possible hardcoded secret detected in src/"
fi
ok "No hardcoded secrets detected"

echo "── Governance scan passed ──"
