# VPN Panel — managed VPS

Панель управляет подписками, реальными VPS и службами Outline/Xray через PostgreSQL.

## Основные возможности

- реестр VPS с SSH-инвентаризацией и fingerprint host key;
- зашифрованное хранение SSH-данных и Outline Management API;
- идемпотентная установка Outline и создание тестовых `ss://` ключей;
- безопасные шаблоны Xray VLESS TCP и VLESS WebSocket TLS с проверкой, атомарной записью и rollback;
- синхронизация UUID и traffic reporter через relay-агенты;
- локальные subscription-файлы и owner-only административный API.

## Запуск

1. Создайте PostgreSQL и заполните `.env.vps` по `.env.vps.example`.
2. Обязательно задайте уникальный `SERVER_SECRETS_KEY` (не выводите его в логи).
3. Запустите `docker compose --env-file .env.vps -f docker-compose.vps.yml up -d --build`.
4. Откройте `/panel` и войдите owner-учётной записью.

## Реальные серверы

Раздел «Реальные серверы» позволяет добавить VPS, проверить SSH, обновить инвентаризацию, установить Outline, создать тестовый ключ и управлять Xray-шаблонами. Удаление службы не удаляет VPS и соседние службы.

Секреты хранятся только в зашифрованном виде. Произвольные shell-команды и произвольный JSON-конфиг запрещены.

## Проверки

```text
npm test
npm run check:repository
```

Перед production делайте резервную копию PostgreSQL и проверяйте health endpoint.
