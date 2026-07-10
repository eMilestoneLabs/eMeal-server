#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# eMeal health + TLS-cert alerter. Runs from cron (every 5 min). Sends a Telegram
# message ONLY on a state change: once when something breaks, once when it recovers
# (no alert spam). Read-only against the app; fully additive — remove by deleting
# the cron line. Needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env.
#
#   Manual test:  bash deploy/healthcheck-alert.sh
#   Cron (5 min): */5 * * * * /home/emeal/eMeal-server/deploy/healthcheck-alert.sh >> /home/emeal/backups/alert.log 2>&1
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail   # NOT -e: a failed probe must not kill the script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
ENVFILE="$(readlink -f "$APP_DIR/.env" 2>/dev/null || echo "$APP_DIR/.env")"
[ -f "$ENVFILE" ] && { set -a; . "$ENVFILE"; set +a; }

HEALTH_URL="${HEALTH_URL:-https://api.emilestone.com/api/v1/health}"
CERT_HOSTS="${CERT_HOSTS:-api.emilestone.com cdn.emilestone.com}"
CERT_WARN_DAYS="${CERT_WARN_DAYS:-14}"
TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TG_CHAT="${TELEGRAM_CHAT_ID:-}"
# Optional email (Hostinger SMTP). Set ALERT_SMTP_* in .env to enable.
SMTP_HOST="${ALERT_SMTP_HOST:-}"          # e.g. smtp.hostinger.com
SMTP_USER="${ALERT_SMTP_USER:-}"          # e.g. admin@emilestone.com
SMTP_PASS="${ALERT_SMTP_PASS:-}"          # mailbox password
SMTP_TO="${ALERT_SMTP_TO:-$SMTP_USER}"    # defaults to the sender
STATE="${ALERT_STATE_DIR:-$HOME/backups}/.health_alert_state"

# ── Auto-heal (guarded hang recovery) ─────────────────────────────────────────
# Closes the "app HANG (alive but 502) is alerted, not restarted" gap. When the
# API health check fails for AUTOHEAL_MIN_FAILS consecutive runs, we do ONE
# `pm2 reload` (zero-downtime cluster reload), then cool down for
# AUTOHEAL_COOLDOWN seconds and cap heals per day — so a genuine crash-loop or a
# dependency outage (Postgres down) can NOT become a restart storm; past the cap
# we go back to alert-only and leave it for a human. Fully additive & opt-out:
# set AUTOHEAL_ENABLED=0 to disable, and it silently no-ops if pm2 isn't present.
AUTOHEAL_ENABLED="${AUTOHEAL_ENABLED:-1}"
AUTOHEAL_APP="${AUTOHEAL_APP:-emeal-server}"
AUTOHEAL_MIN_FAILS="${AUTOHEAL_MIN_FAILS:-2}"     # consecutive bad runs before acting
AUTOHEAL_COOLDOWN="${AUTOHEAL_COOLDOWN:-600}"     # seconds between heals (10 min)
AUTOHEAL_MAX_PER_DAY="${AUTOHEAL_MAX_PER_DAY:-6}" # daily ceiling → then alert-only
FAILS_FILE="${STATE}.fails"       # consecutive API-down counter
HEAL_TS_FILE="${STATE}.lastheal"  # epoch of last heal (cooldown gate)
HEAL_DAY_FILE="${STATE}.healday"  # "YYYY-MM-DD count" (daily-cap gate)

# Telegram (instant push)
send_tg() {  # $1 = text
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ] || { echo "note: telegram not configured"; return; }
  curl -s --max-time 10 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    --data-urlencode chat_id="${TG_CHAT}" --data-urlencode text="$1" >/dev/null || true
}

# Email via Hostinger SMTP over TLS (port 465)
send_mail() {  # $1 = subject, $2 = body
  [ -n "$SMTP_HOST" ] && [ -n "$SMTP_USER" ] && [ -n "$SMTP_PASS" ] || return
  printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\n\r\n%s\r\n' \
    "$SMTP_USER" "$SMTP_TO" "$1" "$2" \
  | curl -s --ssl-reqd --max-time 20 --url "smtps://${SMTP_HOST}:465" \
      --user "${SMTP_USER}:${SMTP_PASS}" \
      --mail-from "$SMTP_USER" --mail-rcpt "$SMTP_TO" --upload-file - >/dev/null || true
}

# Send to BOTH channels
send() {  # $1 = subject/short, $2 = full body (defaults to $1)
  send_tg "${2:-$1}"
  send_mail "$1" "${2:-$1}"
}

# Guarded remediation: ONE pm2 reload for a persistent API hang, rate-limited by
# a cooldown and a daily cap. Returns 0 if it acted, 1 otherwise. Never fatal.
maybe_autoheal() {  # $1 = http code seen (for the message)
  [ "$AUTOHEAL_ENABLED" = "1" ] || return 1
  command -v pm2 >/dev/null 2>&1 || { echo "note: autoheal skipped (pm2 not on PATH)"; return 1; }

  # Consecutive-failure gate: don't act on a single transient blip.
  local fails; fails=$(cat "$FAILS_FILE" 2>/dev/null || echo 0)
  [ "$fails" -ge "$AUTOHEAL_MIN_FAILS" ] || { echo "autoheal: ${fails}/${AUTOHEAL_MIN_FAILS} consecutive fails — waiting"; return 1; }

  # Cooldown gate: at most one heal per AUTOHEAL_COOLDOWN seconds.
  local now last; now=$(date +%s); last=$(cat "$HEAL_TS_FILE" 2>/dev/null || echo 0)
  if [ $(( now - last )) -lt "$AUTOHEAL_COOLDOWN" ]; then
    echo "autoheal: within cooldown ($(( now - last ))s < ${AUTOHEAL_COOLDOWN}s) — alert-only"
    return 1
  fi

  # Daily-cap gate: past the ceiling, stop touching it (a human is needed).
  local today count rec; today=$(date +%F); rec=$(cat "$HEAL_DAY_FILE" 2>/dev/null || echo "")
  if [ "${rec%% *}" = "$today" ]; then count="${rec##* }"; else count=0; fi
  if [ "$count" -ge "$AUTOHEAL_MAX_PER_DAY" ]; then
    send "🛑 eMeal auto-heal capped" "🛑 eMeal ($(hostname)): API still unhealthy (http=${1}) but auto-heal hit its daily cap (${count}/${AUTOHEAL_MAX_PER_DAY}). NOT restarting again — needs manual investigation."
    echo "autoheal: daily cap reached (${count}/${AUTOHEAL_MAX_PER_DAY}) — alert-only"
    return 1
  fi

  # ACT: one zero-downtime cluster reload.
  echo "autoheal: reloading ${AUTOHEAL_APP} (fails=${fails}, http=${1})"
  pm2 reload "$AUTOHEAL_APP" --update-env >/dev/null 2>&1 || pm2 restart "$AUTOHEAL_APP" >/dev/null 2>&1 || true
  echo "$now" > "$HEAL_TS_FILE"
  echo "$today $(( count + 1 ))" > "$HEAL_DAY_FILE"
  echo 0 > "$FAILS_FILE"   # reset streak; next run confirms recovery
  send "🔧 eMeal auto-heal" "🔧 eMeal ($(hostname)): API health FAILED (http=${1}) for ${fails} consecutive checks — performed 'pm2 reload ${AUTOHEAL_APP}'. Verifying recovery on the next check. (heal ${count}→$(( count + 1 )) today)"
  return 0
}

problems=""
api_down=0

# 1) API health (must be HTTP 200 AND status:ok)
code=$(curl -s -o /tmp/.hc.$$ -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null || echo 000)
body=$(cat /tmp/.hc.$$ 2>/dev/null || true); rm -f /tmp/.hc.$$
if [ "$code" != "200" ] || ! printf '%s' "$body" | grep -q '"status":"ok"'; then
  problems="${problems}"$'\n'"❌ API health FAIL (http=${code}) ${HEALTH_URL}"
  api_down=1
fi

# 2) TLS certificate expiry
for h in $CERT_HOSTS; do
  end=$(echo | openssl s_client -servername "$h" -connect "$h:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "$end" ]; then
    days=$(( ( $(date -d "$end" +%s 2>/dev/null) - $(date +%s) ) / 86400 ))
    [ "$days" -lt "$CERT_WARN_DAYS" ] && problems="${problems}"$'\n'"⚠️ TLS cert ${h} expires in ${days} days"
  else
    problems="${problems}"$'\n'"⚠️ could not read TLS cert for ${h}"
  fi
done

prev=$(awk '{print $1}' "$STATE" 2>/dev/null || true)

if [ -n "$problems" ]; then
  [ "$prev" != "down" ] && send "🚨 eMeal infra ALERT" "🚨 eMeal infra alert ($(hostname)):${problems}"
  echo "down $(date -Iseconds)" > "$STATE"
  echo "[$(date -Iseconds)] ALERT:${problems}"

  # Track consecutive API-down streak, then attempt guarded self-healing. Only a
  # genuine API health failure counts toward remediation — a TLS-cert warning
  # alone must never trigger a restart. A cert/other problem still alerts above.
  if [ "$api_down" = "1" ]; then
    echo $(( $(cat "$FAILS_FILE" 2>/dev/null || echo 0) + 1 )) > "$FAILS_FILE"
    maybe_autoheal "$code"
  else
    # API is healthy — only a cert/other warning remains. The streak must reset
    # here too, or a later single API blip could inherit a stale count and heal
    # one check early.
    echo 0 > "$FAILS_FILE"
  fi
else
  [ "$prev" = "down" ] && send "✅ eMeal recovered" "✅ eMeal recovered — API healthy + certs OK ($(hostname))"
  echo "ok $(date -Iseconds)" > "$STATE"
  echo 0 > "$FAILS_FILE"   # clear the streak on any healthy check
  echo "[$(date -Iseconds)] OK — no problems"
fi

# Manual test:  bash deploy/healthcheck-alert.sh test   → fires both channels once
if [ "${1:-}" = "test" ]; then send "eMeal alert test" "✅ eMeal alerting test — Telegram + Email both working ($(hostname))"; echo "test alert sent"; fi
