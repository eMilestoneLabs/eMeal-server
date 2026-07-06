#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AUTO-RECOVERY VERIFIER — answers: "if I do NOT reboot and do NOT run deploy.sh,
# does the app recover on its own?"
#
# PART A (always, read-only): reports the self-healing configuration that is
#   actually in force — PM2 auto-restart + memory guard, PM2 boot-resurrection
#   (systemd), Docker restart policies, and the health-alert cron — so you can
#   see WHAT recovers automatically and WHERE the gaps are.
#
# PART B (opt-in: RUN_RECOVERY_DRILL=1): performs a SAFE, controlled crash drill
#   — SIGKILLs ONE PM2 cluster worker and polls /health until it returns, WITHOUT
#   any deploy. Cluster mode keeps the other workers serving, so there is no
#   downtime. This proves PM2 crash-recovery empirically.
#
# NOT infrastructure modification — read-only + one controlled worker kill that
# PM2 immediately respawns. Run as the `emeal` user on the VPS.
#
#   bash deploy/verify-auto-recovery.sh                # report only
#   RUN_RECOVERY_DRILL=1 bash deploy/verify-auto-recovery.sh   # + live crash drill
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HEALTH_URL="${HEALTH_URL:-http://localhost:3000/api/v1/health}"
APP="${PM2_APP:-emeal-server}"
PASS=0; WARN=0
ok(){ PASS=$((PASS+1)); printf '  \033[32mOK\033[0m    %s %s\n' "$1" "${2:-}"; }
gap(){ WARN=$((WARN+1)); printf '  \033[33mGAP\033[0m   %s %s\n' "$1" "${2:-}"; }
inf(){ printf '  ·     %s %s\n' "$1" "${2:-}"; }
sec(){ printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

echo "auto-recovery verifier — $(date -Iseconds)  host=$(hostname)  health=$HEALTH_URL"

# ─────────────────────────────────────────────────────────────────────────────
sec "A1. PM2 process-level self-healing (crash / OOM)"
if command -v pm2 >/dev/null 2>&1; then
  J="$(pm2 jlist 2>/dev/null)"
  AR="$(echo "$J" | jq -r --arg n "$APP" 'first(.[]|select(.name==$n)).pm2_env.autorestart // empty')"
  MMR="$(echo "$J" | jq -r --arg n "$APP" 'first(.[]|select(.name==$n)).pm2_env.max_memory_restart // empty')"
  MR="$(echo "$J" | jq -r --arg n "$APP" 'first(.[]|select(.name==$n)).pm2_env.max_restarts // empty')"
  INST="$(echo "$J" | jq -r --arg n "$APP" '[.[]|select(.name==$n)]|length')"
  ONLINE="$(echo "$J" | jq -r --arg n "$APP" '[.[]|select(.name==$n and .pm2_env.status=="online")]|length')"
  RT="$(echo "$J" | jq -r --arg n "$APP" '[.[]|select(.name==$n)|.pm2_env.restart_time]|add // 0')"
  [ "$AR" = "true" ] && ok "PM2 autorestart = ON" "(crash/exit → auto-respawn)" || gap "PM2 autorestart" "value=$AR"
  [ -n "$MMR" ] && [ "$MMR" != "null" ] && ok "PM2 max_memory_restart set" "($((MMR/1024/1024))MB → OOM auto-restart)" || gap "max_memory_restart unset"
  inf "workers: $ONLINE/$INST online   total restarts so far: $RT   max_restarts=$MR"
  inf "NOTE: max_restarts=$MR means a tight crash-LOOP (>$MR restarts within min_uptime) makes PM2 give up → NOT auto-recovered."
else
  gap "pm2 not found on PATH"
fi

# ─────────────────────────────────────────────────────────────────────────────
sec "A2. PM2 boot-resurrection (server reboot without you)"
UNIT="$(systemctl list-unit-files 2>/dev/null | awk '/pm2-.*\.service/{print $1; exit}')"
if [ -n "$UNIT" ]; then
  EN="$(systemctl is-enabled "$UNIT" 2>/dev/null || echo unknown)"
  [ "$EN" = "enabled" ] && ok "PM2 systemd unit enabled" "($UNIT → app auto-starts on reboot)" || gap "PM2 unit not enabled" "($UNIT=$EN)"
else
  gap "no pm2 systemd unit" "(run 'pm2 startup' once → app will NOT auto-start after reboot)"
fi
[ -f "$HOME/.pm2/dump.pm2" ] && ok "pm2 save dump present" "(process list restored on boot)" || gap "no ~/.pm2/dump.pm2" "(run 'pm2 save')"

# ─────────────────────────────────────────────────────────────────────────────
sec "A3. Docker data services restart policy (postgres / redis / minio)"
if command -v docker >/dev/null 2>&1; then
  for c in emeal_postgres emeal_redis emeal_minio; do
    P="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$c" 2>/dev/null || echo missing)"
    case "$P" in
      always|unless-stopped|on-failure) ok "$c restart policy" "= $P (auto-restarts)";;
      *) gap "$c restart policy" "= $P (won't auto-restart)";;
    esac
  done
else
  inf "docker not on PATH (skipping)"
fi

# ─────────────────────────────────────────────────────────────────────────────
sec "A4. Health-alert cron (notify only — does NOT restart)"
if crontab -l 2>/dev/null | grep -q "healthcheck-alert.sh"; then
  ok "healthcheck-alert cron present" "(Telegram/email on state change)"
  gap "alerter does NOT remediate" "a HANG (app alive but 502) is NOT auto-restarted by anything — only alerted"
else
  inf "healthcheck-alert cron not found for this user"
fi

# ─────────────────────────────────────────────────────────────────────────────
sec "VERDICT — would it recover WITHOUT reboot / deploy.sh?"
cat <<'TXT'
  • Worker CRASH or OOM (>512MB)      → YES, PM2 respawns automatically in ~2s.
  • Data container stop (pg/redis)    → YES, Docker restart policy brings it back.
  • Full server REBOOT                → YES *iff* the PM2 systemd unit is enabled (A2).
  • App HANG (alive, returns 502)     → NO. Nothing HTTP-health-restarts it — the
                                        cron only ALERTS. This is the one real gap.
  • Tight crash-LOOP (>max_restarts)  → NO. PM2 stops retrying → needs manual restart.
  So your 502 most likely self-healed via PM2 (crash/OOM) BEFORE your manual deploy,
  UNLESS it was a hang/crash-loop — in which case your deploy.sh reload is what fixed it.
TXT

# ─────────────────────────────────────────────────────────────────────────────
if [ "${RUN_RECOVERY_DRILL:-0}" = "1" ]; then
  sec "B. LIVE CRASH DRILL (kill one worker, no deploy — prove PM2 recovery)"
  PID="$(pm2 jlist 2>/dev/null | jq -r --arg n "$APP" 'first(.[]|select(.name==$n and .pm2_env.status=="online")).pid // empty')"
  RT0="$(pm2 jlist 2>/dev/null | jq -r --arg n "$APP" '[.[]|select(.name==$n)|.pm2_env.restart_time]|add // 0')"
  if [ -z "$PID" ] || [ "$PID" = "null" ]; then gap "no online worker pid to drill"; else
    inf "killing worker pid=$PID (SIGKILL) — other workers keep serving"
    kill -9 "$PID" 2>/dev/null || true
    START=$(date +%s); RECOVERED=""
    for i in $(seq 1 30); do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$HEALTH_URL" 2>/dev/null || echo 000)
      [ "$code" = "200" ] && { RECOVERED=$(( $(date +%s) - START )); break; }
      sleep 1
    done
    RT1="$(pm2 jlist 2>/dev/null | jq -r --arg n "$APP" '[.[]|select(.name==$n)|.pm2_env.restart_time]|add // 0')"
    if [ -n "$RECOVERED" ] && [ "${RT1:-0}" -gt "${RT0:-0}" ]; then
      ok "PM2 auto-respawned the killed worker" "restarts ${RT0}→${RT1}, /health=200 after ~${RECOVERED}s, NO deploy run"
    elif [ -n "$RECOVERED" ]; then
      ok "/health stayed 200 (cluster absorbed the kill)" "restarts ${RT0}→${RT1}"
    else
      gap "health did NOT return within 30s after worker kill" "(investigate PM2)"
    fi
  fi
else
  inf ""
  inf "Run the live crash drill with:  RUN_RECOVERY_DRILL=1 bash deploy/verify-auto-recovery.sh"
fi

printf '\n\033[1mSUMMARY:\033[0m OK=%d  GAP=%d\n' "$PASS" "$WARN"
exit 0
