#!/usr/bin/env bash
# Установка Вех на чистый сервер Ubuntu/Debian одной командой:
#   curl -fsSL https://raw.githubusercontent.com/dontpani6/roadmap/main/deploy/install.sh | sudo bash -s -- roadmap.example.com
# Домен можно не указывать, тогда приложение откроется по IP-адресу сервера без HTTPS.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-https://github.com/dontpani6/roadmap}"
DIR="${DIR:-/opt/roadmap}"

if [ "$(id -u)" -ne 0 ]; then echo "Запустите через sudo"; exit 1; fi

echo "==> Ставлю Docker и git"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git)

echo "==> Скачиваю приложение в $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR"

if [ -n "$DOMAIN" ]; then
  printf 'DOMAIN=%s\nCOOKIE_SECURE=1\nPUBLIC_URL=https://%s\n' "$DOMAIN" "$DOMAIN" > .env
else
  IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  printf 'DOMAIN=:80\nCOOKIE_SECURE=0\nPUBLIC_URL=http://%s\n' "$IP" > .env
fi

echo "==> Запускаю"
docker compose up -d --build

echo "==> Включаю автообновление (проверка каждые 5 минут)"
chmod +x deploy/update.sh
cat > /etc/cron.d/roadmap-update <<CRON
*/5 * * * * root $DIR/deploy/update.sh >> /var/log/roadmap-update.log 2>&1
CRON

echo "==> Включаю ежедневную резервную копию в $DIR/backups"
cat > /etc/cron.d/roadmap-backup <<CRON
30 3 * * * root mkdir -p $DIR/backups && tar -czf $DIR/backups/data-\$(date +\%F).tgz -C $DIR data && find $DIR/backups -name 'data-*.tgz' -mtime +14 -delete
CRON

. ./.env
echo
echo "Готово. Откройте ${PUBLIC_URL} и зарегистрируйтесь: первый пользователь станет администратором."
