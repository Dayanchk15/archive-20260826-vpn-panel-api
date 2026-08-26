# VPN Panel — implementation log

## 2026-08-19

- Added encrypted managed-VPS registry and owner-only administration API.
- Added SSH inventory with host-key fingerprint pinning and timeout limits.
- Added idempotent Outline installation/status/key management.
- Added constrained Xray VLESS templates with validation, atomic backup, health check, and rollback.
- Removed retired remote deployment code and rebuilt subscriptions from the PostgreSQL/VPS registry.
- Preserved non-remote VPS services and client assignments.

Operational secrets are supplied only through production environment variables and are never written to logs.
