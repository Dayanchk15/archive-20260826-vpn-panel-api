# Единое развёртывание нового VPS-бандла

`provision-vps-bundle-all.ps1` разворачивает отдельный systemd-сервис
`xray-vps-edge-bundle.service`. Существующие Caddy/Xray/Remnawave-службы на
новом VPS не перезаписываются; используется только собственный конфиг
`/opt/vpn-vps-edge-bundle/config.json`.

Что устанавливается:

- отдельный SS-2022 inbound на уникальном TCP/UDP-порту для каждого активного клиента;
- четыре VLESS TCP inbound-порта (FR1, FR2, Fornex, Tampa);
- отдельные VLESS outbounds на каждого клиента, поэтому UUID не смешиваются;
- traffic reporter через локальный Xray Stats API;
- синхронизация UUID активных клиентов в dedicated FR1 relay;
- регистрация линий в подписках и удаление старого адреса только при явном `-RetireServer`.

## Запуск

Из каталога проекта:

```powershell
cd C:\Users\Admin\vpn-panel-api
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-vps-bundle-all.ps1 `
  -Server "NEW_SERVER_IP" `
  -SshPassword "NEW_SERVER_PASSWORD" `
  -Fr1 "185.209.230.14" `
  -Fr1SshKey "C:\Users\Admin\.ssh\id_ed25519"
```

Если FR1 принимает пароль, вместо ключа используйте `-Fr1SshPassword`.
Пароль нового VPS не записывается в файл и передаётся дочернему Python-процессу
только на время запуска. Для повторного запуска с прежними портами укажите те
же `-SsPortBase` и `-VlessPortBase`.

После успешного запуска старый заблокированный адрес можно убрать из подписок:

```powershell
... -RetireServer "OLD_SERVER_IP"
```

Не добавляйте `-RetireServer`, пока не проверены новые порты.

## Проверка на самом VPS

```bash
systemctl is-active xray-vps-edge-bundle
xray run -test -config /opt/vpn-vps-edge-bundle/config.json
ss -ltnup | grep -E ':20000|:21000|:21001|:21002|:21003'
systemctl is-active vps-bundle-traffic-reporter.service || true
```

Если на VPS включён UFW, установщик сам открывает диапазоны SS и VLESS. Внешний
firewall провайдера нужно разрешить отдельно: UDP/TCP SS-порты и TCP-порты
VLESS.
