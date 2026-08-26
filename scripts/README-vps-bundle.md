# Новый VPS: SS + VLESS TCP multi-egress

После создания чистого VPS с доступом `root` запустить из корня проекта:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-vps-bundle-all.ps1 `
  -Server 203.0.113.10 `
-PasswordFile C:\Users\Admin\password.txt
```

По умолчанию используется SSH-пользователь `root`. Если провайдер отключил вход
root по паролю, укажите разрешённого пользователя и порт, например:

```powershell
-SshUser ubuntu -SshPort 22
```

Если нужно передать пароль непосредственно в PowerShell (это попадёт в историю
команд), используйте `-SshPassword`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-vps-bundle-all.ps1 `
  -Server 203.0.113.10 `
  -SshPassword 'ВАШ_ПАРОЛЬ'
```

Если новый VPS заменяет заблокированный, укажите старый IP через `-RetireServer`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-vps-bundle-all.ps1 `
  -Server 203.0.113.10 `
  -SshPassword 'ВАШ_ПАРОЛЬ' `
  -RetireServer 'ЗАБЛОКИРОВАННЫЙ_IP'
```

При наличии `-SshPassword` он имеет приоритет над `-PasswordFile`. Пароль не
печатается скриптом и удаляется из переменной окружения после завершения.

Скрипт:

- получает только активных клиентов из панели;
- создаёт изолированный `xray-vps-edge-bundle.service`;
- создаёт отдельный SS-2022 порт и пароль для каждого клиента с названием `🇷🇺 Russia Moscow`;
- создаёт четыре VLESS TCP входа (FR1, FR2, Fornex, Tampa), каждый со своим outbound;
- публикует линии `🇫🇷 France 1 Fast`, `🇫🇷 France 2 Fast`, `🇩🇪 Germany Fast`, `🇺🇸 USA Fast`;
- включает Xray Stats API и отдельный traffic reporter;
- добавляет личные SS/VLESS-ссылки в подписки клиентов с резервной копией;
- удаляет линии заменяемого старого IP у всех активных клиентов;
- не останавливает и не перезапускает существующие сервисы VPS.

Порты по умолчанию: SS `20000+`, VLESS `21000–21003`, локальный Stats API `127.0.0.1:10105`.
Профили исходящих соединений находятся в `config/new-vps-egresses.json`. Если у конкретного
сервера изменены домен, SNI, путь или порт, сначала исправить только этот JSON-файл.

Перед запуском проверьте, что SSH к VPS доступен (`Test-NetConnection <IP> -Port 22`).
Скрипт не включает UFW; если UFW уже активен, он только добавляет необходимые диапазоны портов.
