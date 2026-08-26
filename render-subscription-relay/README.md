# Render subscription relay

This small service keeps the public subscription URL unchanged while fetching
only `/api/sub/<token>` from the configured subscription origin. It is not an
open proxy and does not handle VPN traffic.

## Render settings

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Environment variable: `SUBSCRIPTION_ORIGIN=https://sub.twidu.com`

Render supplies `PORT` automatically. Do not hard-code it.

## Local test

```powershell
npm start
curl.exe http://127.0.0.1:10000/health
curl.exe -i http://127.0.0.1:10000/api/sub/TEST_TOKEN
```

The test token should return the upstream status. Never put a real token in a
public repository or in logs.
