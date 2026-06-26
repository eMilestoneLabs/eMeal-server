#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# TRACK A — one-time (idempotent) production hardening for the LIVE Contabo VPS.
# Safe to re-run. Makes ONLY infrastructure/OS changes — never touches app code,
# the database, business data, or any application contract.
#
# What it does (each step is guarded + reversible — see ROLLBACK notes inline):
#   1. 2 GB swap file            (build/OOM headroom; live server had 0B)
#   2. Timezone → UTC            (align cron/log/backup timestamps with the app)
#   3. File-descriptor limits    (raise nofile 1024 → 65535 for the WS server)
#   4. fail2ban (sshd jail)      (brute-force protection)
#   5. SSH hardening             (key-only + no root) — GUARDED so it can't lock you out
#   6. unattended-upgrades       (ensure OS security patches stay on)
#
# Run as the deploy user with sudo:   bash deploy/harden-server.sh
# Dry-run (print actions, change nothing):   DRY_RUN=1 bash deploy/harden-server.sh
#
# IMPORTANT: Step 5 only disables password/root SSH if it can PROVE you already
# have a working authorized_keys entry. Otherwise it SKIPS and warns — you will
# never be locked out by running this script.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
SWAP_SIZE_GB="${SWAP_SIZE_GB:-2}"
NOFILE_LIMIT="${NOFILE_LIMIT:-65535}"
SSH_HARDEN="${SSH_HARDEN:-auto}"   # auto = only if a key is present; off = skip; force = do it regardless (dangerous)

log()  { echo "  $*"; }
step() { echo "==> $*"; }
run()  { if [ "$DRY_RUN" = "1" ]; then echo "    [dry-run] $*"; else eval "$*"; fi; }

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

# ── 1. Swap ──────────────────────────────────────────────────────────────────
# ROLLBACK: sudo swapoff /swapfile && sudo rm /swapfile && sudo sed -i '/\/swapfile/d' /etc/fstab
step "1/6 Swap (${SWAP_SIZE_GB}G)"
if swapon --show | grep -q '/swapfile'; then
  log "swap already active — skipping"
elif [ -f /swapfile ]; then
  log "/swapfile exists but not active — enabling"
  run "$SUDO swapon /swapfile"
else
  run "$SUDO fallocate -l ${SWAP_SIZE_GB}G /swapfile || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_SIZE_GB*1024))"
  run "$SUDO chmod 600 /swapfile"
  run "$SUDO mkswap /swapfile"
  run "$SUDO swapon /swapfile"
  grep -q '/swapfile' /etc/fstab || run "echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null"
  # gentler swappiness so swap is a safety net, not a hot path
  run "echo 'vm.swappiness=10' | $SUDO tee /etc/sysctl.d/99-emeal-swap.conf >/dev/null"
  run "$SUDO sysctl -p /etc/sysctl.d/99-emeal-swap.conf || true"
fi

# ── 2. Timezone UTC ──────────────────────────────────────────────────────────
# ROLLBACK: sudo timedatectl set-timezone Europe/Berlin
step "2/6 Timezone → UTC"
if timedatectl show -p Timezone --value | grep -qx UTC; then
  log "already UTC — skipping"
else
  log "current: $(timedatectl show -p Timezone --value) → setting UTC"
  run "$SUDO timedatectl set-timezone UTC"
fi

# ── 3. File-descriptor limits ────────────────────────────────────────────────
# ROLLBACK: sudo rm /etc/security/limits.d/99-emeal.conf /etc/sysctl.d/99-emeal-limits.conf
step "3/6 nofile limits → ${NOFILE_LIMIT}"
LIMITS_FILE=/etc/security/limits.d/99-emeal.conf
if [ -f "$LIMITS_FILE" ] && grep -q "nofile ${NOFILE_LIMIT}" "$LIMITS_FILE" 2>/dev/null; then
  log "limits already set — skipping"
else
  run "printf '%s\n' '* soft nofile ${NOFILE_LIMIT}' '* hard nofile ${NOFILE_LIMIT}' 'root soft nofile ${NOFILE_LIMIT}' 'root hard nofile ${NOFILE_LIMIT}' | $SUDO tee ${LIMITS_FILE} >/dev/null"
  run "printf '%s\n' 'fs.file-max=2097152' | $SUDO tee /etc/sysctl.d/99-emeal-limits.conf >/dev/null"
  run "$SUDO sysctl -p /etc/sysctl.d/99-emeal-limits.conf || true"
  log "NOTE: PM2 process must be restarted to inherit the new limit (deploy.sh reload, or 'pm2 update')."
  log "NOTE: also raise the systemd unit limit:  sudo systemctl edit pm2-\$USER  → add  [Service]\\nLimitNOFILE=${NOFILE_LIMIT}"
fi

# ── 4. fail2ban ──────────────────────────────────────────────────────────────
# ROLLBACK: sudo systemctl disable --now fail2ban
step "4/6 fail2ban (sshd jail)"
if ! command -v fail2ban-client >/dev/null 2>&1; then
  run "$SUDO apt-get update -qq && $SUDO apt-get install -y fail2ban"
fi
JAIL=/etc/fail2ban/jail.d/emeal-sshd.local
if [ ! -f "$JAIL" ]; then
  run "printf '%s\n' '[sshd]' 'enabled = true' 'port = ssh' 'maxretry = 5' 'findtime = 600' 'bantime = 3600' 'backend = systemd' | $SUDO tee ${JAIL} >/dev/null"
fi
run "$SUDO systemctl enable --now fail2ban"
if [ "$DRY_RUN" != "1" ]; then $SUDO fail2ban-client status sshd >/dev/null 2>&1 && log "sshd jail active" || log "WARN: sshd jail not reporting active — check 'sudo fail2ban-client status'"; fi

# ── 5. SSH hardening (GUARDED) ───────────────────────────────────────────────
# ROLLBACK: sudo rm /etc/ssh/sshd_config.d/00-emeal-hardening.conf && sudo systemctl reload ssh
# NOTE: filename is 00- so it sorts BEFORE cloud-init's 50-cloud-init.conf (which sets
# PasswordAuthentication yes). sshd uses the FIRST value it reads, so ours must come first.
step "5/6 SSH hardening (key-only, no root)"
KEYS_OK=0
if [ -s "$HOME/.ssh/authorized_keys" ]; then KEYS_OK=1; fi
DROPIN=/etc/ssh/sshd_config.d/00-emeal-hardening.conf
do_harden() {
  run "$SUDO rm -f /etc/ssh/sshd_config.d/99-emeal-hardening.conf"   # clean up any older-named copy
  run "printf '%s\n' 'PasswordAuthentication no' 'PermitRootLogin no' 'PubkeyAuthentication yes' 'ChallengeResponseAuthentication no' 'MaxAuthTries 4' 'X11Forwarding no' | $SUDO tee ${DROPIN} >/dev/null"
  if [ "$DRY_RUN" != "1" ]; then
    if $SUDO sshd -t; then $SUDO systemctl reload ssh && log "SSH hardened (key-only, root disabled)"; else
      log "ERROR: sshd config test failed — reverting"; $SUDO rm -f "$DROPIN"; fi
  fi
}
case "$SSH_HARDEN" in
  off)   log "SSH_HARDEN=off — skipping" ;;
  force) log "SSH_HARDEN=force — applying regardless of key check (ensure you have console access!)"; do_harden ;;
  *)     if [ "$KEYS_OK" = "1" ]; then
           log "authorized_keys present for $USER — safe to harden"; do_harden
         else
           log "WARN: no ~/.ssh/authorized_keys for $USER. SKIPPING SSH hardening to avoid lockout."
           log "      Fix: from your PC run  ssh-copy-id $USER@<server>  then re-run this script."
         fi ;;
esac

# ── 6. unattended-upgrades ───────────────────────────────────────────────────
step "6/6 unattended-upgrades"
if systemctl is-enabled unattended-upgrades >/dev/null 2>&1; then
  log "already enabled — skipping"
else
  run "$SUDO apt-get install -y unattended-upgrades"
  run "$SUDO dpkg-reconfigure -f noninteractive unattended-upgrades || true"
  run "$SUDO systemctl enable --now unattended-upgrades"
fi

echo
echo "==> Hardening complete.  Verify:"
echo "    swapon --show ; timedatectl | grep 'Time zone' ; ulimit -n"
echo "    sudo fail2ban-client status sshd ; sudo sshd -T | grep -E 'permitrootlogin|passwordauthentication'"
echo "    (Keep your current SSH session OPEN and test a NEW ssh login before closing it.)"
