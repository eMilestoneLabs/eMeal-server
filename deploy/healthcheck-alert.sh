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

problems=""

# 1) API health (must be HTTP 200 AND status:ok)
code=$(curl -s -o /tmp/.hc.$$ -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null || echo 000)
body=$(cat /tmp/.hc.$$ 2>/dev/null || true); rm -f /tmp/.hc.$$
if [ "$code" != "200" ] || ! printf '%s' "$body" | grep -q '"status":"ok"'; then
  problems="${problems}"$'\n'"❌ API health FAIL (http=${code}) ${HEALTH_URL}"
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
else
  [ "$prev" = "down" ] && send "✅ eMeal recovered" "✅ eMeal recovered — API healthy + certs OK ($(hostname))"
  echo "ok $(date -Iseconds)" > "$STATE"
  echo "[$(date -Iseconds)] OK — no problems"
fi

# Manual test:  bash deploy/healthcheck-alert.sh test   → fires both channels once
if [ "${1:-}" = "test" ]; then send "eMeal alert test" "✅ eMeal alerting test — Telegram + Email both working ($(hostname))"; echo "test alert sent"; fi
