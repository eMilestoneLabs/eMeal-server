#!/usr/bin/env bash
# One-time Contabo VPS 10 provisioning (Ubuntu 22.04) for emilestone.com.
# Run as a sudo-capable user. IP: 5.189.153.205
set -euo pipefail

echo "==> System update + base packages"
sudo apt update && sudo apt upgrade -y
sudo apt install -y git ufw nginx certbot python3-certbot-nginx curl wget unzip

echo "==> Firewall"
sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

echo "==> Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo bash
  sudo usermod -aG docker "$USER"
  echo "Log out/in (or run: newgrp docker) for docker group to apply."
fi

echo "==> Node 20 LTS via nvm + PM2"
if ! command -v node >/dev/null; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
  nvm install 20 && nvm alias default 20
fi
npm install -g pm2 || sudo npm install -g pm2

echo "==> Done. Next: clone repo to /opt/emeal-server, fill .env, run deploy/deploy.sh"
