#!/usr/bin/env bash
# Setup BACKEND Umira AI di Ubuntu 22.04/24.04: Node 22, MySQL 8, PM2, Nginx.
# Jalankan dari folder backend:
#   sudo API_DOMAIN=api.umira.id FRONTEND_URL=https://ai.umira.id bash scripts/setup-ubuntu.sh
# Opsional: DB_PASS=..., WITH_REDIS=1, NO_NGINX=1 (bila Nginx dikelola di server lain), APP_USER=<pemilik folder>
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"
APP_USER="${APP_USER:-${SUDO_USER:-$(stat -c %U "$DIR")}}"
API_DOMAIN="${API_DOMAIN:-_}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}"
DB_PASS="${DB_PASS:-$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)}"
step() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
as_app() { sudo -u "$APP_USER" -H bash -lc "cd '$DIR' && $*"; }

[ "$(id -u)" -eq 0 ] || { echo "Jalankan dengan sudo"; exit 1; }

step "Paket sistem"
apt-get update -y
apt-get install -y curl ca-certificates gnupg build-essential mysql-server
[ "${NO_NGINX:-0}" = "1" ] || apt-get install -y nginx
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v pm2 >/dev/null || npm i -g pm2
[ "${WITH_REDIS:-0}" = "1" ] && { apt-get install -y redis-server; systemctl enable --now redis-server; }
systemctl enable --now mysql

step "Database umira_ai"
mysql <<SQL
CREATE DATABASE IF NOT EXISTS umira_ai CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'umira'@'localhost' IDENTIFIED BY '${DB_PASS}';
CREATE USER IF NOT EXISTS 'umira'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
ALTER USER 'umira'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER 'umira'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON umira_ai.* TO 'umira'@'localhost';
GRANT ALL PRIVILEGES ON umira_ai.* TO 'umira'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

step ".env"
API_HOST=127.0.0.1; [ "${NO_NGINX:-0}" = "1" ] && API_HOST=0.0.0.0
as_app "node scripts/init-env.mjs --db-pass='$DB_PASS' --frontend-url='$FRONTEND_URL' --api-host=$API_HOST"
[ "${WITH_REDIS:-0}" = "1" ] && as_app "sed -i 's#^REDIS_URL=.*#REDIS_URL=redis://127.0.0.1:6379#' .env"
chmod 600 "$DIR/.env"

step "Install, build, migrasi, seed"
as_app "npm install && npm run build && npm run db:migrate && npm run db:seed:prod"

step "PM2 (auto-start saat boot)"
as_app "pm2 start ecosystem.config.cjs --update-env && pm2 save"
env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "$(getent passwd "$APP_USER" | cut -d: -f6)" >/dev/null

if [ "${NO_NGINX:-0}" != "1" ]; then
  step "Nginx (${API_DOMAIN})"
  sed "s/server_name _;/server_name ${API_DOMAIN};/" deploy/nginx-api.conf > /etc/nginx/sites-available/umira-api
  ln -sf /etc/nginx/sites-available/umira-api /etc/nginx/sites-enabled/umira-api
  [ "$API_DOMAIN" = "_" ] && rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
fi

cat <<TXT

✅ Backend berjalan.  Cek: curl http://${API_DOMAIN/_/localhost}/api/v1/health
   Password DB tersimpan di .env (DATABASE_URL).

Langkah berikut:
 1. nano .env → HERMES_BASE_URL & HERMES_API_KEY (dan pastikan CORS_ORIGINS = URL frontend) → npm run restart
 2. HTTPS: sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d ${API_DOMAIN}
    lalu COOKIE_SECURE=true, SWAGGER_ENABLED=false → npm run restart
TXT
