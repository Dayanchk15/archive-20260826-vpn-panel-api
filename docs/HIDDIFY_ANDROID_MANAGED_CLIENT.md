# DADA Connect — managed Hiddify Android prototype

## Scope

The existing DADA VPN application remains unchanged. `hiddify-dada-android/` is
a separate local Android prototype based on Hiddify App `v4.1.1`, with Hiddify
Core left intact.

The application has no activation screen and no user-facing import path. It
creates an anonymous rotating mobile session and receives only servers enabled
for DADA Connect in the panel.

## Control-plane API

Canonical endpoints:

- `POST /api/hiddify-android/v1/bootstrap`
- `POST /api/hiddify-android/v1/session/refresh`
- `DELETE /api/hiddify-android/v1/session`
- `GET /api/hiddify-android/v1/profile`
- `GET /api/hiddify-android/v1/releases/latest`

Bunny/Hostinger compatibility aliases:

- `/api/status/hidbootstrap`
- `/api/status/hidrefresh`
- `/api/status/hidsession`
- `/api/status/hidprofile`
- `/api/status/hidrelease`

The server list uses independent fields:

- `hiddifyAndroidEnabled`
- `hiddifyAndroidDisplayName`
- `hiddifyAndroidCountryCode`
- `hiddifyAndroidPriority`
- `hiddifyAndroidMinVersion`
- `hiddifyAndroidMaintenance`

Changing these values changes the next profile response and does not require a
new APK. The panel tab **DADA Connect** contains the settings, server membership
controls, and the manual profile revision button.

## Runtime flow

1. The app obtains an anonymous session through `levospeed.it.com`.
2. Access and refresh tokens are stored with Android encrypted storage.
3. The structured panel profile is cached in encrypted storage.
4. The app builds an in-memory local VLESS profile for Hiddify Core.
5. Hiddify Core keeps ownership of VPN lifecycle, routing, DNS and Android TUN.
6. The panel profile refreshes at launch, before connecting, periodically, and
   when the user presses **Обновить серверы**.

Manual server choice installs a one-server managed core profile. Automatic mode
restores the full managed list. TCP port latency checks run with at most three
parallel sockets and do not require an active VPN connection.

## Required environment

`MOBILE_JWT_SECRET`, PostgreSQL and either `HIDDIFY_ANDROID_PUBLIC_UUID` or the
temporary `MOBILE_PUBLIC_UUID` fallback are required. A separate UUID is
recommended before a production pilot.

## Verification status

The Node.js API, admin panel JavaScript, and the complete backend test suite are
verified locally. Flutter 3.38.5 is not installed on the current machine; run
the following in CI or a prepared Android workstation before any pilot:

```text
flutter pub get
dart run build_runner build --delete-conflicting-outputs
flutter analyze
flutter test
flutter build apk --debug --target lib/main_prod.dart
```

Do not publish or distribute the modified client until upstream licence and
branding permission has been confirmed.
