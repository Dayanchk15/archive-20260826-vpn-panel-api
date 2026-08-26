# DADA VPN

В репозитории находятся две связанные части:

- мобильный API и элементы управления в текущей панели;
- нативный Android-клиент в `android-client/`.

Happ-подписки, существующие ссылки и текущая логика панели не заменяются.

## Запуск мобильного API

Мобильные сессии требуют PostgreSQL. В production задайте как минимум:

```env
DATABASE_URL=postgres://...
POSTGRES_SSL=true
MOBILE_JWT_SECRET=<отдельный случайный секрет не короче 64 hex-символов>
MOBILE_PUBLIC_ACCESS=true
MOBILE_PUBLIC_UUID=<отдельный случайный UUID v4 для общего DADA VPN-доступа>
```

При запуске панель автоматически создаёт таблицы кодов активации, сессий, истории ротации refresh-токенов, rate limit и диагностики.

Основные endpoints:

- `POST /api/mobile/v1/bootstrap` — автоматическая анонимная сессия установки;
- `POST /api/mobile/v1/activate`;
- `POST /api/mobile/v1/session/refresh`;
- `DELETE /api/mobile/v1/session`;
- `GET /api/mobile/v1/profile`;
- `POST /api/mobile/v1/diagnostics`;
- `GET /api/mobile/v1/releases/latest`.

Основной Android-клиент не запрашивает код активации и не создаёт пользовательскую учётную запись. Он вызывает `bootstrap`, передавая случайный installation ID, модель устройства и версию приложения. В базе installation ID хранится только как SHA-256, а каждой установке выдаётся собственная ротируемая мобильная сессия.

`MOBILE_PUBLIC_UUID` — скрытая общая VLESS-учётная запись приложения. Во время синхронизации edge-нод она автоматически добавляется только на серверы с `mobileEnabled=true`. Legacy endpoint активации сохранён для обратной совместимости, но новым APK не используется.

## Включение серверов

Сервер не попадёт в приложение, пока администратор явно не включит флаг «Показывать сервер в DADA VPN». Для первой версии должны выполняться условия:

- `protocol=vless`;
- `network=ws`;
- `security=tls`;
- сервер включён, не находится на обслуживании и назначен клиенту;
- минимальная версия APK не выше установленной.

Адрес, UUID, Host, path и TLS-параметры передаются только внутри авторизованного профиля, хранятся через Android Keystore и не отображаются в интерфейсе.

## Android-сборка

Требуются JDK 17, Android SDK 35 и Gradle 8.9:

```powershell
cd android-client
.\scripts\fetch-libxray.ps1
gradle :app:testDebugUnitTest :app:assembleDebug
```

Production API и публичный ключ release-манифеста задаются при сборке:

```powershell
gradle :app:assembleRelease `
  -PDADA_API_BASE_URL=https://panel.example.com `
  -PDADA_RELEASE_PUBLIC_KEY_BASE64=<X509-RSA-public-key-base64>
```

Release signing Android задаётся локальным `android-client/keystore.properties`. Один и тот же JKS нужен для всех последующих APK.

## Публикация обновления

Release-манифест подписывается отдельным RSA-ключом. Приватный ключ не включается в APK и не хранится в панели.

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out release-manifest-private.pem
openssl pkey -in release-manifest-private.pem -pubout -outform DER | openssl base64 -A
```

После сборки подписанного APK:

```powershell
npm run mobile:release-manifest -- `
  --apk android-client/app/build/outputs/apk/release/app-release.apk `
  --private-key C:/secure/release-manifest-private.pem `
  --apk-url https://downloads.example.com/dada-vpn-2.apk `
  --version-code 2 `
  --version-name 1.1.0 `
  --minimum-version-code 1 `
  --changelog "Исправления стабильности"
```

Полученные значения публикуются через переменные `MOBILE_*` из `.env.example` либо соответствующие настройки панели. Клиент проверяет подпись манифеста, SHA-256 APK, Package ID, `versionCode` и совпадение Android signing certificate до открытия системного установщика.

## Диагностика и приватность

Диагностика выключена по умолчанию. После явного согласия отправляются только версия приложения/Android, модель устройства, этап соединения, код общей ошибки, выбранный внутренний ID ноды и измеренная задержка. Посещённые сайты, DNS-история и содержимое трафика не собираются.
