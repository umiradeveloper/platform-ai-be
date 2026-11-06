#!/usr/bin/env bash
# Setup BACKEND Umira AI di macOS (Homebrew + MySQL + Node 22).
# Jalankan dari folder backend:  bash scripts/setup-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DB_PASS="${DB_PASS:-umira_password}"
step() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }

command -v brew >/dev/null || { echo "Homebrew belum terpasang. Install dulu: https://brew.sh"; exit 1; }

step "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  brew install node@22 && brew link --overwrite --force node@22
fi
node -v

step "MySQL 8"
if ! command -v mysql >/dev/null; then
  brew install mysql@8.4 && brew link --force mysql@8.4
fi
brew services start mysql@8.4 2>/dev/null || brew services start mysql 2>/dev/null || true
for i in $(seq 1 30); do mysqladmin ping --silent 2>/dev/null && break; sleep 1; done

step "Database umira_ai & user umira"
# Instalasi baru Homebrew: root tanpa password. Bila root berpassword: MYSQL_ROOT_PASSWORD=... bash scripts/setup-mac.sh
MYSQL_ROOT=(mysql -uroot)
[ -n "${MYSQL_ROOT_PASSWORD:-}" ] && MYSQL_ROOT=(mysql -uroot "-p${MYSQL_ROOT_PASSWORD}")
"${MYSQL_ROOT[@]}" <<SQL
CREATE DATABASE IF NOT EXISTS umira_ai CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'umira'@'localhost' IDENTIFIED BY '${DB_PASS}';
CREATE USER IF NOT EXISTS 'umira'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
ALTER USER 'umira'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER 'umira'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON umira_ai.* TO 'umira'@'localhost';
GRANT ALL PRIVILEGES ON umira_ai.* TO 'umira'@'127.0.0.1';
-- prisma migrate dev butuh shadow database
GRANT CREATE, DROP ON *.* TO 'umira'@'localhost';
GRANT CREATE, DROP ON *.* TO 'umira'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

step ".env"
node scripts/init-env.mjs --db-pass="$DB_PASS"

step "Install, migrasi, seed"
npm install
npx prisma generate
npm run db:migrate
npm run db:seed

cat <<'TXT'

✅ Backend siap.
  npm run dev            → http://localhost:4000/api/v1/health   (Swagger: http://localhost:4000/api/docs)
  npm run mock:hermes    → (opsional) Hermes tiruan di :8642, key: test-hermes-key

Isi HERMES_API_KEY di .env = API_SERVER_KEY di ~/.hermes/.env, lalu jalankan `hermes gateway`.
Production lokal: npm i -g pm2 && npm run build && npm start
TXT
