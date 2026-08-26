# Render / AS397273

Canonical scanners: `../../run-tm-render-gentle-scan.ps1`, `../../build-render-front-candidates.mjs`.
Results: `tmp/ip-scans/render/`.

## FR1 Render CDN (isolated origin)

This setup uses Render only as a WebSocket edge. FR1 runs a separate plain
VLESS+WebSocket listener; the existing relay/Bunny/Caddy services are not
restarted. Do not expose a production UUID: use a dedicated test UUID first.

### 1. Install the isolated FR1 origin

Copy `install-fr1-origin.sh` to FR1 and run as root:

```bash
chmod 700 install-fr1-origin.sh
./install-fr1-origin.sh 7865 '<TEST_UUID>' /render-fr1-ws
ss -lntp | grep ':7865'
systemctl status xray-fr1-render-ws --no-pager
```

Open TCP `7865` in the FR1 firewall/security group if Render cannot reach it.
The origin is deliberately plain WS; TLS terminates at Render.

### 2. Create the Render Web Service

Use the GitHub repository with **Root Directory** `vpn-ws-relay`:

- Runtime: Node
- Build command: `npm install`
- Start command: `node server.js`
- Health check path: `/health`
- `UPSTREAM_WS_URL=ws://<FR1_PUBLIC_IP>:7865/render-fr1-ws`
- `RELAY_WS_PING_MS=30000`

Render provides an HTTPS hostname such as `vpn-fr1.onrender.com`. Keep the
service private until the health check and WebSocket test pass.

### 3. Generate a test VLESS link

After Render deploys, run locally (do not add it to all clients yet):

```powershell
node .\scripts\cdn\render\build-vless-link.mjs `
  --uuid '<TEST_UUID>' `
  --host 'vpn-fr1.onrender.com' `
  --path '/render-fr1-ws' `
  --name '🇫🇷 Render FR1 TEST'
```

Test `/health` first, then test the generated VLESS link in Happ. Only after
successful tests should the node be added to the panel and client profiles.
