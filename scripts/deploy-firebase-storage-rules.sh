#!/bin/bash
# Опубликовать Firebase Storage Rules (публичное чтение subscription.txt и u-*.txt).
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-project-b5d55fc6-713d-4201-a8d}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"

if command -v firebase >/dev/null 2>&1; then
  echo "=== Deploy Firebase Storage Rules ==="
  firebase deploy --only storage --project "$PROJECT_ID"
else
  echo "firebase CLI не установлен."
  echo "Установка: npm install -g firebase-tools"
  echo "Потом: firebase login && bash scripts/deploy-firebase-storage-rules.sh"
  echo ""
  echo "Или вручную: https://console.firebase.google.com/project/${PROJECT_ID}/storage/rules"
  echo ""
  cat config/firebase-storage.rules
  exit 1
fi

echo ""
echo "=== Проверка (пример) ==="
echo 'curl -I "https://storage.googleapis.com/project-10d5f.firebasestorage.app/subscription-kLbDNE4u6pJpCwUyydba.txt"'
echo "Ожидается: HTTP/2 200"
