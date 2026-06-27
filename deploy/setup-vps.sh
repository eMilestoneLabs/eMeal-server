#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# eMeal — production VPS provisioner (Ubuntu 22.04/24.04 LTS).
# Goal: a BRAND-NEW VPS becomes production-ready by running this once:
#         bash deploy/setup-vps.sh
# It is SAFE, IDEMPOTENT and REPEATABLE — re-running only fills gaps, never
# clobbers existing config, secrets, data, or the database.
#
# It provisions INFRASTRUCTURE ONLY (no app code/business logic/contracts):
#   base packages · UFW · Docker + Compose · Node 20 (nvm) · PM2 + logrotate ·
#   rclone (offsite backups) · swap · UTC · ulimits · fail2ban · SSH hardening ·
#   unattended-upgrades · Nginx · Certbot · backup cron · log/journald caps.
#
# AUTOMATED here when their prerequisites exist (re-run to complete them):
#   • Data services (need .env)            • MinIO bucket + public-read (needs .env + MinIO up)
#   • SSL certificate (needs DNS pointing at THIS host)
#
# Stays MANUAL (the irreducible ~5% — they need YOUR credentials / human consent):
#   • DNS A-records (live at your registrar)   • the real .env secret values
#   • rclone's one-time Google OAuth consent
# So on a fresh box: run this → fill .env + point DNS → RE-RUN this, and it
# finishes data services, the bucket, and SSL automatically.
#
# Env overrides:
#   APP_DIR        default: this repo's root (parent of deploy/)
#   APP_USER       default: current user
#   BRANCH         default: eMeal-server
#   API_DOMAIN     default: api.emilestone.com
#   CDN_DOMAIN     default: cdn.emilestone.com
#   CERTBOT_EMAIL  default: admin@emilestone.com   (Let's Encrypt expiry notices)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(dirname "$SCRIPT_DIR")}"
APP_USER="${APP_USER:-$(id -un)}"
BRANCH="${BRANCH:-eMeal-server}"
API_DOMAIN="${API_DOMAIN:-api.emilestone.com}"
CDN_DOMAIN="${CDN_DOMAIN:-cdn.emilestone.com}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@emilestone.com}"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
step() { echo; echo "==> $*"; }
log()  { echo "  $*"; }

# ── 1. Base packages ─────────────────────────────────────────────────────────
step "1/14 System update + base packages"
$SUDO apt-get update -qq
$SUDO DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
$SUDO apt-get install -y git curl wget unzip ca-certificates gnupg \
  ufw nginx certbot python3-certbot-nginx fail2ban unattended-upgrades jq

# ── 2. Firewall (only 22/80/443 in) ──────────────────────────────────────────
step "2/14 Firewall (UFW)"
$SUDO ufw allow 22/tcp
$SUDO ufw allow 80/tcp
$SUDO ufw allow 443/tcp
$SUDO ufw default deny incoming
$SUDO ufw default allow outgoing
$SUDO ufw --force enable
$SUDO ufw status verbose | sed 's/^/  /'

# ── 3. Docker + Compose plugin ───────────────────────────────────────────────
step "3/14 Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | $SUDO bash
fi
if ! id -nG "$APP_USER" | grep -qw docker; then
  $SUDO usermod -aG docker "$APP_USER"
  log "Added $APP_USER to docker group — log out/in (or 'newgrp docker') to apply."
fi
docker --version | sed 's/^/  /'
docker compose version | sed 's/^/  /' || log "WARN: docker compose plugin missing"

# ── 4. Node 20 LTS (nvm) + PM2 + logrotate ───────────────────────────────────
step "4/14 Node 20 LTS + PM2"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
nvm install 20 >/dev/null && nvm alias default 20 >/dev/null
command -v pm2 >/dev/null 2>&1 || npm install -g pm2
pm2 list >/dev/null 2>&1 || true
# logrotate module: 100M cap, retain 30, daily, compress (keeps PM2 logs bounded)
pm2 list 2>/dev/null | grep -q pm2-logrotate || pm2 install pm2-logrotate || true
pm2 set pm2-logrotate:max_size 100M    || true
pm2 set pm2-logrotate:retain 30        || true
pm2 set pm2-logrotate:compress true    || true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *' || true
# PM2 systemd autostart (resurrect on reboot)
pm2 startup systemd -u "$APP_USER" --hp "$HOME" 2>/dev/null | grep -E '^sudo ' | bash || \
  log "If PM2 startup printed a sudo command, run it once to enable boot persistence."
node -v | sed 's/^/  node /'; pm2 -v | sed 's/^/  pm2 /'

# ── 5. rclone (offsite backups to Google Drive) ──────────────────────────────
step "5/14 rclone (offsite backup transport)"
if ! command -v rclone >/dev/null 2>&1; then
  curl -fsSL https://rclone.org/install.sh | $SUDO bash
fi
rclone version | head -1 | sed 's/^/  /'
log "Configure the Google Drive remote once:  rclone config   (name it 'gdrive')"

# ── 6. OS hardening (swap, UTC, ulimits, fail2ban, SSH, auto-updates) ─────────
step "6/14 OS hardening (delegates to harden-server.sh — idempotent + guarded)"
bash "$SCRIPT_DIR/harden-server.sh"

# ── 7. journald + Docker log caps (prevent disk-fill) ────────────────────────
step "7/14 Log size caps (journald + Docker)"
$SUDO mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\nMaxRetentionSec=14day\n' | \
  $SUDO tee /etc/systemd/journald.conf.d/99-emeal.conf >/dev/null
$SUDO systemctl restart systemd-journald || true
# Docker daemon default log caps (compose files also set per-service caps)
if [ ! -f /etc/docker/daemon.json ]; then
  printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "20m", "max-file": "5" }\n}\n' | \
    $SUDO tee /etc/docker/daemon.json >/dev/null
  $SUDO systemctl restart docker || true
else
  log "/etc/docker/daemon.json exists — leaving as-is (compose sets per-service caps)."
fi

# ── 8. App directories ───────────────────────────────────────────────────────
step "8/14 Directories"
mkdir -p "$HOME/backups/db" "$HOME/backups/minio" "$HOME/backups/config" \
         "$HOME/backups/weekly" "$HOME/backups/monthly" "$APP_DIR/logs"

# ── 9. Data services (Postgres + Redis + MinIO) ──────────────────────────────
step "9/14 Data services (docker compose)"
if [ -f "$APP_DIR/.env" ]; then
  ( cd "$APP_DIR" && docker compose -f docker-compose.prod.yml up -d )
  log "Containers started."
else
  log "SKIP: $APP_DIR/.env not found. Create it (cp .env.production.example .env; chmod 600 .env;"
  log "      fill secrets) then RE-RUN this script to auto-start services + bucket + SSL."
fi

# ── 10. MinIO bucket + public-read (idempotent; needs .env + MinIO running) ───
# Replaces the old manual STEP 6. Waits for MinIO to answer, creates the bucket
# (mc mb -p = no error if it already exists) and sets anonymous download so the
# CDN vhost can serve images. Skips cleanly if prerequisites aren't ready.
step "10/14 MinIO bucket (public-read for images)"
if [ -f "$APP_DIR/.env" ]; then
  set -a; . "$APP_DIR/.env"; set +a
  if [ -n "${MINIO_ACCESS_KEY:-}" ] && [ -n "${MINIO_SECRET_KEY:-}" ] && [ -n "${MINIO_BUCKET:-}" ]; then
    mok=0
    for _ in $(seq 1 10); do
      if curl -fsS --max-time 3 "http://127.0.0.1:9000/minio/health/ready" >/dev/null 2>&1; then mok=1; break; fi
      sleep 2
    done
    if [ "$mok" = "1" ]; then
      if docker run --rm --network host --entrypoint /bin/sh minio/mc -c "
            mc alias set l http://localhost:9000 '$MINIO_ACCESS_KEY' '$MINIO_SECRET_KEY' >/dev/null &&
            { mc mb -p l/'$MINIO_BUCKET' >/dev/null 2>&1 || true; } &&
            mc anonymous set download l/'$MINIO_BUCKET'" >/dev/null 2>&1; then
        log "Bucket '$MINIO_BUCKET' ready (public-read)."
      else
        log "WARN: bucket setup failed (check MINIO_* creds) — see handbook PART 2 STEP 6."
      fi
    else
      log "SKIP: MinIO not ready on 127.0.0.1:9000 yet — re-run after services are up."
    fi
  else
    log "SKIP: MINIO_* not set in .env — fill secrets, then re-run."
  fi
else
  log "SKIP: $APP_DIR/.env not found — create it, then re-run to auto-create the bucket."
fi

# ── 11. Nginx site ───────────────────────────────────────────────────────────
step "11/14 Nginx reverse proxy"
if [ -f "$APP_DIR/nginx/emilestone.conf" ]; then
  $SUDO cp "$APP_DIR/nginx/emilestone.conf" /etc/nginx/sites-available/emilestone
  $SUDO ln -sf /etc/nginx/sites-available/emilestone /etc/nginx/sites-enabled/emilestone
  $SUDO rm -f /etc/nginx/sites-enabled/default
  # Tighten system-wide TLS — drop deprecated TLSv1/TLSv1.1 (idempotent; vhosts already enforce 1.2/1.3)
  $SUDO sed -i 's/ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;/ssl_protocols TLSv1.2 TLSv1.3;/' /etc/nginx/nginx.conf 2>/dev/null || true
  if $SUDO nginx -t 2>/dev/null; then $SUDO systemctl reload nginx; else
    log "WARN: nginx -t failed (often because SSL certs not issued yet — step 12 will fix once DNS resolves)."; fi
fi

# ── 12. SSL certificate (non-interactive; guarded by a DNS check) ─────────────
# Replaces the old manual STEP 8. Only issues if $API_DOMAIN already resolves to
# THIS host's public IP (otherwise the ACME challenge fails) — so it is safe to
# run before DNS is set: it just skips and tells you to re-run. Idempotent: skips
# entirely once a cert exists.
#
# We use `certonly --standalone` (NOT --nginx) on purpose: nginx/emilestone.conf
# hard-references /etc/letsencrypt/live/... cert files, so on a fresh box `nginx -t`
# fails until certs exist — which would also trip the --nginx plugin. Standalone
# stops nginx briefly to bind port 80 for the ACME challenge, with no dependency on
# a valid nginx config. The saved --pre-hook/--post-hook make `certbot renew`
# (certbot.timer) stop+start nginx automatically too, so renewals keep working.
step "12/14 SSL (Let's Encrypt — auto when DNS points here)"
if [ -d "/etc/letsencrypt/live/$API_DOMAIN" ]; then
  log "Certificate for $API_DOMAIN already present — skipping (auto-renews via certbot.timer)."
else
  MYIP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
  DNIP="$(getent hosts "$API_DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
  if [ -n "$MYIP" ] && [ "$DNIP" = "$MYIP" ]; then
    $SUDO systemctl stop nginx 2>/dev/null || true
    if $SUDO certbot certonly --standalone -d "$API_DOMAIN" -d "$CDN_DOMAIN" \
         --non-interactive --agree-tos -m "$CERTBOT_EMAIL" \
         --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx"; then
      $SUDO systemctl start nginx 2>/dev/null || true
      $SUDO nginx -t && $SUDO systemctl reload nginx || true
      log "SSL issued for $API_DOMAIN, $CDN_DOMAIN (renewals auto-stop/start nginx)."
    else
      $SUDO systemctl start nginx 2>/dev/null || true
      log "WARN: certbot failed — verify port 80 is reachable + DNS, then re-run (handbook PART 2 STEP 8)."
    fi
  else
    log "SKIP SSL: $API_DOMAIN resolves to '${DNIP:-<none>}' but this host is '${MYIP:-<unknown>}'."
    log "         (If you front the server with Cloudflare/a proxy, issue SSL manually — handbook STEP 8.)"
    log "         Point the DNS A-records here, then RE-RUN setup-vps.sh to auto-issue SSL."
  fi
fi

# ── 13. Backup + alert crons ─────────────────────────────────────────────────
step "13/14 Backup + alert crons"
CRON_LINE="0 2 * * * BACKUP_REMOTE=gdrive:eMeal-Backups $APP_DIR/deploy/backup.sh >> $HOME/backups/cron.log 2>&1"
if crontab -l 2>/dev/null | grep -qF "$APP_DIR/deploy/backup.sh"; then
  log "backup cron already present — skipping"
else
  ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
  log "Installed: $CRON_LINE"
fi
# Health/cert alerter every 5 min (needs TELEGRAM_BOT_TOKEN/CHAT_ID in .env)
ALERT_LINE="*/5 * * * * $APP_DIR/deploy/healthcheck-alert.sh >> $HOME/backups/alert.log 2>&1"
if crontab -l 2>/dev/null | grep -qF "$APP_DIR/deploy/healthcheck-alert.sh"; then
  log "alert cron already present — skipping"
else
  ( crontab -l 2>/dev/null; echo "$ALERT_LINE" ) | crontab -
  log "Installed: $ALERT_LINE"
fi

# ── 14. Next steps ───────────────────────────────────────────────────────────
step "14/14 Done — what (if anything) is left"
cat <<EOF
  This script AUTO-COMPLETES when prerequisites exist (re-run to finish):
    • data services (need .env)   • MinIO bucket   • SSL (needs DNS pointing here)

  The irreducible MANUAL steps (your credentials / one-time human consent):
  1) DNS: point  $API_DOMAIN  and  $CDN_DOMAIN  →  this server's IP (at your registrar).
  2) Secrets: cd $APP_DIR && cp .env.production.example .env && chmod 600 .env  (fill CHANGE_ME)
              — or run deploy/rotate-secrets.sh to auto-generate the internal ones.
  3) rclone:  rclone config   (create 'gdrive' remote — one-time Google OAuth consent)
              then test:  $APP_DIR/deploy/backup.sh

  Then:
  4) RE-RUN this script   →   it starts services, creates the bucket, issues SSL.
  5) Deploy:  cd $APP_DIR && ./deploy/deploy.sh
  6) (optional) Monitoring: cd $APP_DIR/deploy/monitoring && docker compose -f docker-compose.monitoring.yml up -d
EOF
