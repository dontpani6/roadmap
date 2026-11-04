#!/usr/bin/env bash
# Подтягивает новую версию из GitHub и перезапускает приложение, если что-то изменилось.
# Запускается по cron каждые 5 минут (ставит deploy/install.sh). Данные в ./data не трогаются.
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch -q origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then exit 0; fi

echo "$(date -Is) обновляю $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
git merge -q --ff-only origin/main
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
