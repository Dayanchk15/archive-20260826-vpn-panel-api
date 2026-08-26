# DADA Connect: локальные сборки Android и iOS

Это отдельный управляемый клиент на базе форка Hiddify. Проект DADA VPN в
`android-client/` этой сборкой не изменяется.

## Android

Для большинства современных телефонов используйте ARM64 APK:

`releases/DADA-Connect-Android-arm64-test-v0.1.1.apk`

Это release-mode сборка для локальной проверки, подписанная Android debug
сертификатом. Публиковать или раздавать её как production-релиз нельзя. Перед
публикацией нужен постоянный release keystore.

Если архитектура телефона неизвестна, используйте универсальный debug APK:

`releases/DADA-Connect-Android-debug-v0.1.0.apk`

## iOS

iOS-сборка требует macOS, Xcode и Apple Developer Team. На Mac из корня
`hiddify-dada-android` выполните:

```bash
bash scripts/build-ios-local.sh
```

Скрипт скачивает закреплённую версию Hiddify Core, генерирует Dart-код и
создаёт неподписанный `build/ios/iphoneos/Runner.app`.

Для установки на настоящий iPhone откройте `ios/Runner.xcworkspace` в Xcode и
настройте один Apple Team для двух targets:

- `Runner` с bundle ID `com.dadavpn.connect`;
- `HiddifyPacketTunnel` с bundle ID
  `com.dadavpn.connect.HiddifyPacketTunnel`.

Обоим targets нужны одинаковая App Group `group.com.dadavpn.connect` и
профили с Network Extension / Packet Tunnel capability. После этого выполните
Archive и экспортируйте development/ad-hoc IPA средствами Xcode.

CI-проверка неподписанной iOS-компиляции находится в
`hiddify-dada-android/.github/workflows/dada-connect-ios-verify.yml`.
