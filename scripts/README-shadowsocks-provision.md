# Быстрая установка Shadowsocks Rust

Установщик не хранит SSH-пароль в файлах и запрашивает его интерактивно.
Он проверяет занятый порт, устанавливает Shadowsocks Rust, создаёт systemd-службу,
открывает выбранный TCP/UDP-порт (если активен UFW), запускает сервер и печатает
готовую `ss://` ссылку.

Из корня проекта Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-shadowsocks-rust.ps1 -Server 77.110.105.115
```

По умолчанию используется `443/tcp+udp`, метод
`2022-blake3-aes-128-gcm`, а ключ генерируется случайно. Повторный запуск
сохраняет существующий ключ. Для осознанной ротации ключа:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-shadowsocks-rust.ps1 -Server 77.110.105.115 -RotateKey
```

Скрипт останавливает только `shadowsocks-rust`, если он уже существует; другие
службы не изменяет. Не добавляйте напечатанную ссылку в общие подписки без
отдельной проверки и согласования.
