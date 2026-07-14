-- Uniqueness audit (unique_mandatory_rules.xlsx) — race-proof DB constraints.
--
-- Service-layer duplicate checks already exist for every rule below, but a
-- pre-check + insert is not atomic: two concurrent requests can both pass the
-- check. These partial/functional UNIQUE indexes close that window at the
-- database, and the global exception filter maps the resulting P2002 to a
-- clean 409 (flat error contract).
--
-- Every index is guarded: if live data already violates a rule (possible only
-- for rows written before the service-layer checks existed), the index is
-- SKIPPED with a WARNING instead of failing the deploy. Re-running the guard
-- after cleaning the named duplicates will create it (see SERVER_HANDBOOK).
--
-- NOTE: partial/functional indexes cannot be declared in schema.prisma —
-- raw SQL here is the established pattern (see 20260705000000_pass14_lifecycle).

-- ── UNI-001: email is globally unique (case-insensitive, whole platform) ────
-- Writes normalize to lowercase; pre-2026-07-04 rows may store mixed case,
-- so the index is on lower(email). Deleted accounts are anonymized to the
-- per-user 'deleted-<id>@anonymized.invalid' address, which never collides.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'users_email_global_uniq') THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT lower(email) FROM users WHERE email IS NOT NULL
    GROUP BY lower(email) HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING 'UNI-001: duplicate emails exist — index users_email_global_uniq SKIPPED. Resolve duplicates, then re-run this block.';
    RETURN;
  END IF;
  EXECUTE 'CREATE UNIQUE INDEX users_email_global_uniq ON users (lower(email)) WHERE email IS NOT NULL';
END $$;

-- ── UNI-002: mobile number is globally unique (whole platform) ──────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'users_phone_global_uniq') THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT phone FROM users WHERE phone IS NOT NULL
    GROUP BY phone HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING 'UNI-002: duplicate phone numbers exist — index users_phone_global_uniq SKIPPED. Resolve duplicates, then re-run this block.';
    RETURN;
  END IF;
  EXECUTE 'CREATE UNIQUE INDEX users_phone_global_uniq ON users (phone) WHERE phone IS NOT NULL';
END $$;

-- ── UNI-005/006/007: one ACTIVE group per (org, type, normalized name) ──────
-- Normalization mirrors the service rule: trim + collapse internal spaces +
-- lowercase. Archived groups (isActive = false) never reserve names.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'groups_org_type_name_active_uniq') THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT "organizationId", type, lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
    FROM groups WHERE "isActive" = true
    GROUP BY 1, 2, 3 HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING 'UNI-005: duplicate active group names exist — index groups_org_type_name_active_uniq SKIPPED. Resolve duplicates, then re-run this block.';
    RETURN;
  END IF;
  EXECUTE $idx$CREATE UNIQUE INDEX groups_org_type_name_active_uniq ON groups ("organizationId", type, lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) WHERE "isActive" = true$idx$;
END $$;

-- ── UNI-016: one ACTIVE meal per (group, normalized name) ───────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'meals_group_name_active_uniq') THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT "groupId", lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
    FROM meals WHERE "isActive" = true
    GROUP BY 1, 2 HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING 'UNI-016: duplicate active meal names exist — index meals_group_name_active_uniq SKIPPED. Resolve duplicates, then re-run this block.';
    RETURN;
  END IF;
  EXECUTE $idx$CREATE UNIQUE INDEX meals_group_name_active_uniq ON meals ("groupId", lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) WHERE "isActive" = true$idx$;
END $$;

-- ── UNI-035 support: index for the single-owner FCM-token claim ─────────────
-- claimFcmToken() releases a token from other holders with
-- `UPDATE users SET "fcmToken" = NULL WHERE "fcmToken" = $1 AND id <> $2` —
-- this partial index keeps that an index scan at any user count (runs on
-- every token registration). NOT unique: legacy rows may still share a token
-- until each device re-registers; the claim + batch dedupe handle those.
CREATE INDEX IF NOT EXISTS "users_fcmToken_idx" ON users ("fcmToken") WHERE "fcmToken" IS NOT NULL;

-- ── UNI-028: one FINALIZED billing period per (group, exact span) ───────────
-- The service already rejects OVERLAPPING finalized periods; this closes the
-- concurrent double-finalize race for the identical span (financial safety).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'billing_periods_group_span_finalized_uniq') THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT "groupId", "periodStart", "periodEnd"
    FROM billing_periods WHERE status = 'finalized'
    GROUP BY 1, 2, 3 HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING 'UNI-028: duplicate finalized billing periods exist — index billing_periods_group_span_finalized_uniq SKIPPED. Resolve duplicates, then re-run this block.';
    RETURN;
  END IF;
  EXECUTE $idx$CREATE UNIQUE INDEX billing_periods_group_span_finalized_uniq ON billing_periods ("groupId", "periodStart", "periodEnd") WHERE status = 'finalized'$idx$;
END $$;
