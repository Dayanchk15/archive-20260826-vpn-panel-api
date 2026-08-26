# TM CDN IP scan

Эти скрипты только ищут доступные edge IP для Bunny и Fastly из текущей сети. Они ничего не меняют в панели, DNS, Caddy, Bunny или Fastly.

Когда телефон подключен как модем и нужно проверить именно через TM:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-tm-cdn-ip-scan.ps1 -Provider all
```

Если надо явно указать IP USB-модема:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-tm-cdn-ip-scan.ps1 -Provider all -LocalAddress 172.20.10.2
```

Быстрый тест только Bunny:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-tm-cdn-ip-scan.ps1 -Provider bunny -Limit 200
```

Тест Bunny из заранее сохранённого списка IP, без обращения к Bunny API во время проверки:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-tm-bunny-ip-scan.ps1
```

По умолчанию используется расширенный список `tmp/bunny-all-candidates-merged.txt`, если он есть. В него входят официальный Bunny edge-list и IPv4 из BGP-префиксов `AS200325`.

Двойной Bunny-тест: наш hostname `levospeedfr2.b-cdn.net` и альтернативный `rocko.b-cdn.net`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-tm-bunny-dual-scan.ps1
```

Быстрый тест только Fastly:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-tm-cdn-ip-scan.ps1 -Provider fastly -Limit 300
```

Результаты сохраняются в:

- `tmp/tm-cdn-ip-scan-*.json`
- `tmp/tm-cdn-ip-scan-*.csv`

В отчёте самые важные поля:

- `tcpMs` — порт 443 доступен или нет
- `tlsMs` — TLS handshake с нужным SNI
- `httpStatus` — HTTP ответ через этот IP
- `wsStatus` — WebSocket ответ; для Bunny хороший признак обычно `101`
- `country` — страна Bunny edge, если CDN вернул заголовок

После скана выбираем IP из верхних `OK` строк и меняем только тестовую линию/клиента, не трогая рабочие сервера.
