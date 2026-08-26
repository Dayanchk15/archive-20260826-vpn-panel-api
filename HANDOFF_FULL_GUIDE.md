# VPN Panel handoff

## Production deployment

Run `scripts/deploy-vps.sh` from the repository root. The script creates a PostgreSQL migration backup, deploys the API, removes retired deployment artifacts, and performs a health check.

## Managed VPS workflow

1. Open **Реальные серверы** in the owner panel.
2. Add the address, SSH port, and credential. The panel pins the SSH host fingerprint and inventories services without changing them.
3. Open a server to inspect systemd, Docker, listening ports, and health checks.
4. Install Outline idempotently, then create a test key. Keys stay server-side and are not assigned to clients automatically.
5. Create Xray tunnels only from the supported VLESS TCP or WebSocket/TLS templates. Validation runs before an atomic install; failed restarts roll back the previous configuration.

## Safety

Secrets require `SERVER_SECRETS_KEY`, are encrypted at rest, and are never returned in API responses or logs. Service deletion is scoped to the selected unit/container; the VPS and neighboring services remain untouched.
