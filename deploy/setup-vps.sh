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
# It does NOT: write your real .env (you do that, chmod 600), issue SSL
# (run certbot once DNS resolves), or start the app (deploy/deploy.sh does that).
#
# Env overrides:
#   APP_DIR   default: this repo's root (parent of deploy/)
#   APP_USER  default: current user
#   BRANCH    default: eMeal-server
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(dirname "$SCRIPT_DIR")}"
APP_USER="${APP_USER:-$(id -un)}"
BRANCH="${BRANCH:-eMeal-server}"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
step() { echo; echo "==> $*"; }
log()  { echo "  $*"; }

# ── 1. Base packages ─────────────────────────────────────────────────────────
step "1/12 System update + base packages"
$SUDO apt-get update -qq
$SUDO DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
$SUDO apt-get install -y git curl wget unzip ca-certificates gnupg \
  ufw nginx certbot python3-certbot-nginx fail2ban unattended-upgrades jq

# ── 2. Firewall (only 22/80/443 in) ──────────────────────────────────────────
step "2/12 Firewall (UFW)"
$SUDO ufw allow 22/tcp
$SUDO ufw allow 80/tcp
$SUDO ufw allow 443/tcp
$SUDO ufw default deny incoming
$SUDO ufw default allow outgoing
$SUDO ufw --force enable
$SUDO ufw status verbose | sed 's/^/  /'

# ── 3. Docker + Compose plugin ───────────────────────────────────────────────
step "3/12 Docker"
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
step "4/12 Node 20 LTS + PM2"
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
step "5/12 rclone (offsite backup transport)"
if ! command -v rclone >/dev/null 2>&1; then
  curl -fsSL https://rclone.org/install.sh | $SUDO bash
fi
rclone version | head -1 | sed 's/^/  /'
log "Configure the Google Drive remote once:  rclone config   (name it 'gdrive')"

# ── 6. OS hardening (swap, UTC, ulimits, fail2ban, SSH, auto-updates) ─────────
step "6/12 OS hardening (delegates to harden-server.sh — idempotent + guarded)"
bash "$SCRIPT_DIR/harden-server.sh"

# ── 7. journald + Docker log caps (prevent disk-fill) ────────────────────────
step "7/12 Log size caps (journald + Docker)"
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
step "8/12 Directories"
mkdir -p "$HOME/backups/db" "$HOME/backups/minio" "$HOME/backups/config" \
         "$HOME/backups/weekly" "$HOME/backups/monthly" "$APP_DIR/logs"

# ── 9. Data services (Postgres + Redis + MinIO) ──────────────────────────────
step "9/12 Data services (docker compose)"
if [ -f "$APP_DIR/.env" ]; then
  ( cd "$APP_DIR" && docker compose -f docker-compose.prod.yml up -d )
  log "Containers started."
else
  log "SKIP: $APP_DIR/.env not found. Create it (cp .env.production.example .env; chmod 600 .env;"
  log "      fill secrets) then run:  docker compose -f docker-compose.prod.yml up -d"
fi

# ── 10. Nginx site ───────────────────────────────────────────────────────────
step "10/12 Nginx reverse proxy"
if [ -f "$APP_DIR/nginx/emilestone.conf" ]; then
  $SUDO cp "$APP_DIR/nginx/emilestone.conf" /etc/nginx/sites-available/emilestone
  $SUDO ln -sf /etc/nginx/sites-available/emilestone /etc/nginx/sites-enabled/emilestone
  $SUDO rm -f /etc/nginx/sites-enabled/default
  # Tighten system-wide TLS — drop deprecated TLSv1/TLSv1.1 (idempotent; vhosts already enforce 1.2/1.3)
  $SUDO sed -i 's/ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;/ssl_protocols TLSv1.2 TLSv1.3;/' /etc/nginx/nginx.conf 2>/dev/null || true
  if $SUDO nginx -t; then $SUDO systemctl reload nginx; else
    log "WARN: nginx -t failed (often because SSL certs not issued yet — run certbot first)."; fi
fi

# ── 11. Backup cron (daily 02:00, offsite to Google Drive) ───────────────────
step "11/12 Backup cron"
CRON_LINE="0 2 * * * BACKUP_REMOTE=gdrive:eMeal-Backups $APP_DIR/deploy/backup.sh >> $HOME/backups/cron.log 2>&1"
if crontab -l 2>/dev/null | grep -qF "$APP_DIR/deploy/backup.sh"; then
  log "backup cron already present — skipping"
else
  ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
  log "Installed: $CRON_LINE"
fi

# ── 12. Next steps ───────────────────────────────────────────────────────────
step "12/12 Done — remaining MANUAL steps"
cat <<EOF
  1) DNS: api.emilestone.com + cdn.emilestone.com  →  this server's IP
  2) Secrets:   cd $APP_DIR && cp .env.production.example .env && chmod 600 .env  (fill CHANGE_ME)
  3) SSL:       sudo certbot --nginx -d api.emilestone.com -d cdn.emilestone.com
  4) MinIO bucket + public-read:
       source $APP_DIR/.env
       docker run --rm --network host minio/mc sh -c \\
         "mc alias set local http://localhost:9000 \$MINIO_ACCESS_KEY \$MINIO_SECRET_KEY && \\
          mc mb -p local/\$MINIO_BUCKET && mc anonymous set download local/\$MINIO_BUCKET"
  5) rclone:    rclone config   (create 'gdrive' remote)  then test: $APP_DIR/deploy/backup.sh
  6) Deploy:    cd $APP_DIR && ./deploy/deploy.sh
  7) (optional) Monitoring:  cd $APP_DIR/deploy/monitoring && docker compose -f docker-compose.monitoring.yml up -d
EOF
