#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# accounts.sh — the project's EXISTING test accounts, centralized in one place.
# Source-only. Sets each credential as a DEFAULT: an explicit env var always
# wins, so CI / another org can override without editing this file.
#
# These are the SAME throwaway test logins already committed in
# deploy/validate-e2e.sh — two org admins + two students. Centralizing them here
# (DRY) lets `bash deploy/srs/run.sh` work with zero env, exactly as asked
# ("use those existing accounts"). They are NON-PRODUCTION test users only.
#
# PROD-SAFE: this file is pure configuration. It touches NO application code and
# NO infrastructure. It is read by the ops validation suite only.
# ─────────────────────────────────────────────────────────────────────────────
[ -n "${_SRS_ACCOUNTS_SOURCED:-}" ] && return 0
_SRS_ACCOUNTS_SOURCED=1

# ── Org 1 admin (primary) ────────────────────────────────────────────────────
export ADMIN_EMAIL="${ADMIN_EMAIL:-Manas.Bhattacharya.Primary@gmail.com}"
export ADMIN_PASS="${ADMIN_PASS:-Test@123456}"

# ── Student (member of org 1) ────────────────────────────────────────────────
export STUDENT_EMAIL="${STUDENT_EMAIL:-animesh.bhattacharya.6108@gmail.com}"
export STUDENT_PASS="${STUDENT_PASS:-Animesh@7810}"

# ── Second student (member of org 1) — powers cross-USER isolation probes ─────
export STUDENT2_EMAIL="${STUDENT2_EMAIL:-suravimukherjee129@gmail.com}"
export STUDENT2_PASS="${STUDENT2_PASS:-Suravi@123}"

# ── Org 2 admin (second tenant — powers cross-org isolation probes) ───────────
export ADMIN2_EMAIL="${ADMIN2_EMAIL:-Soumyakantimal95@gmail.com}"
export ADMIN2_PASS="${ADMIN2_PASS:-5747462625@Sou}"
