#!/usr/bin/env python3
"""Provision an isolated VLESS TCP hop -> FR1.

The new VPS accepts VLESS TCP on --listen-port and forwards it over a
dedicated VLESS TCP inbound on FR1. Existing services and configs are kept;
conflicting ports abort before any change.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import shlex
import uuid
from datetime import datetime, timezone
from urllib.parse import quote

import paramiko


XRAY_DIR = "/opt/vpn-vless-tcp-fr1-relay"
XRAY_CONFIG = f"{XRAY_DIR}/config.json"
XRAY_UNIT = "xray-vless-tcp-fr1-relay.service"
XRAY_API_PORT = 10095
FR1_DIR = "/opt/vpn-fr1-vless-tcp-relay"
FR1_CONFIG = f"{FR1_DIR}/config.json"
FR1_UNIT = "xray-fr1-vless-tcp-relay.service"
FR1_API_PORT = 10096


def connect(host: str, password: str | None, key: str | None, port: int = 22):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        host,
        port=port,
        username="root",
        password=password,
        key_filename=key,
        timeout=25,
        auth_timeout=25,
        banner_timeout=25,
        allow_agent=not bool(password),
        look_for_keys=not bool(password),
    )
    return c


def run(c, command: str, timeout: int = 300) -> str:
    _, out, err = c.exec_command(command, timeout=timeout)
    text = out.read().decode("utf-8", "replace")
    problem = err.read().decode("utf-8", "replace")
    code = out.channel.recv_exit_status()
    if code:
        raise RuntimeError(problem.strip() or text.strip() or f"remote exit {code}")
    return text


def upload(c, path: str, text: str, mode: int = 0o600):
    s = c.open_sftp()
    try:
        with s.open(path, "w") as f:
            f.write(text)
        s.chmod(path, mode)
    finally:
        s.close()


def ensure_xray(c):
    have = run(c, "command -v xray || true").strip()
    if have:
        return have
    # Cloud images often run unattended-upgrades on first boot. Wait for the
    # package lock instead of killing that process or partially installing.
    run(
        c,
        "for i in $(seq 1 60); do "
        "  if (flock -n 9) 9>/var/lib/dpkg/lock-frontend && "
        "     (flock -n 8) 8>/var/lib/dpkg/lock; then break; fi; "
        "  sleep 5; "
        "done; "
        "if ! (flock -n 9) 9>/var/lib/dpkg/lock-frontend && "
        "   (flock -n 8) 8>/var/lib/dpkg/lock; then "
        "  echo 'dpkg lock is still held after 5 minutes' >&2; exit 75; "
        "fi",
        330,
    )
    run(
        c,
        "export DEBIAN_FRONTEND=noninteractive; "
        "apt-get update -qq; apt-get install -y -qq curl ca-certificates unzip",
        300,
    )
    run(
        c,
        "set -e; cd /tmp; "
        "curl -fsSL https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -o xray-relay.zip; "
        "rm -rf xray-relay-x; mkdir xray-relay-x; unzip -oq xray-relay.zip -d xray-relay-x; "
        "install -m 0755 xray-relay-x/xray /usr/local/bin/xray; rm -rf xray-relay.zip xray-relay-x",
        300,
    )
    return "/usr/local/bin/xray"


def unit(description: str, config: str, log: str) -> str:
    return f"""[Unit]
Description={description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/xray run -config {config}
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
StandardOutput=append:{log}
StandardError=append:{log}

[Install]
WantedBy=multi-user.target
"""


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--server", required=True, help="new ingress VPS IPv4/hostname")
    p.add_argument("--fr1", default="185.209.230.14")
    p.add_argument("--listen-port", type=int, default=18443)
    p.add_argument("--fr1-port", type=int, default=18444)
    p.add_argument("--api-port", type=int, default=XRAY_API_PORT)
    p.add_argument("--fr1-api-port", type=int, default=FR1_API_PORT)
    p.add_argument("--uuid", help="reuse an existing UUID during a safe config repair")
    p.add_argument("--ssh-port", type=int, default=22)
    p.add_argument("--ssh-password", default=os.getenv("VLESS_FR1_RELAY_SSH_PASSWORD"))
    p.add_argument("--fr1-key", default=os.getenv("FR1_SSH_KEY", r"C:\Users\Admin\.ssh\id_ed25519"))
    a = p.parse_args()
    if not (1 <= a.listen_port <= 65535 and 1 <= a.fr1_port <= 65535):
        raise SystemExit("ports must be between 1 and 65535")
    password = a.ssh_password or getpass.getpass(f"SSH password for root@{a.server}: ")
    relay = fr1 = None
    uid = a.uuid or ""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    try:
        relay = connect(a.server, password, None, a.ssh_port)
        # Abort before changes if the chosen ingress port belongs to another service.
        busy = run(relay, f"ss -ltnup 2>/dev/null | grep -E ':{a.listen_port}([[:space:]]|$)' || true").strip()
        if busy and "xray" not in busy:
            raise RuntimeError(f"ingress port {a.listen_port} is occupied:\n{busy}")
        xray = ensure_xray(relay)
        run(relay, f"mkdir -p {shlex.quote(XRAY_DIR)}; test -f {shlex.quote(XRAY_CONFIG)} && cp -a {shlex.quote(XRAY_CONFIG)} {shlex.quote(XRAY_CONFIG + '.bak-' + stamp)} || true")
        if not uid:
            try:
                sftp = relay.open_sftp()
                with sftp.open(XRAY_CONFIG, 'r') as handle:
                    existing_cfg = json.loads(handle.read().decode('utf-8'))
                sftp.close()
                for inbound in existing_cfg.get('inbounds', []):
                    for client in inbound.get('settings', {}).get('clients', []):
                        candidate = str(client.get('id', '')).strip()
                        if candidate:
                            uid = candidate
                            break
                    if uid:
                        break
            except (OSError, ValueError, json.JSONDecodeError):
                pass
        if not uid:
            uid = str(uuid.uuid4())

        fr1 = connect(a.fr1, None, a.fr1_key)
        busy_fr1 = run(fr1, f"ss -ltnup 2>/dev/null | grep -E ':{a.fr1_port}([[:space:]]|$)' || true").strip()
        if busy_fr1 and "xray" not in busy_fr1:
            raise RuntimeError(f"FR1 port {a.fr1_port} is occupied:\n{busy_fr1}")
        fr1_xray = ensure_xray(fr1)
        run(fr1, f"mkdir -p {shlex.quote(FR1_DIR)}; test -f {shlex.quote(FR1_CONFIG)} && cp -a {shlex.quote(FR1_CONFIG)} {shlex.quote(FR1_CONFIG + '.bak-' + stamp)} || true")

        fr1_email = f"relay-from-{a.server}"
        ingress_email = f"client-ingress-{a.server}"
        fr1_cfg = {
            "api": {"tag": "api", "services": ["StatsService", "HandlerService"]},
            "log": {"loglevel": "warning"},
            "stats": {},
            "inbounds": [{
                "tag": "vless-fr1-relay-in",
                "listen": "0.0.0.0",
                "port": a.fr1_port,
                "protocol": "vless",
                "settings": {"clients": [{"id": uid, "email": fr1_email}], "decryption": "none"},
                "streamSettings": {"network": "tcp", "security": "none"},
            }, {
                "tag": "api",
                "listen": "127.0.0.1",
                "port": a.fr1_api_port,
                "protocol": "dokodemo-door",
                "settings": {"address": "127.0.0.1"},
            }],
            "outbounds": [{"tag": "direct", "protocol": "freedom"}, {"tag": "block", "protocol": "blackhole"}],
            "routing": {"rules": [
                {"type": "field", "inboundTag": ["api"], "outboundTag": "api"},
                {"type": "field", "inboundTag": ["vless-fr1-relay-in"], "outboundTag": "direct"},
            ]},
            "policy": {"levels": {"0": {"statsUserUplink": True, "statsUserDownlink": True}}, "system": {
                "statsInboundUplink": True, "statsInboundDownlink": True,
                "statsOutboundUplink": True, "statsOutboundDownlink": True,
            }},
        }
        relay_cfg = {
            "api": {"tag": "api", "services": ["StatsService", "HandlerService"]},
            "log": {"loglevel": "warning"},
            "stats": {},
            "inbounds": [{
                "tag": "vless-fr1-relay-ingress",
                "listen": "0.0.0.0",
                "port": a.listen_port,
                "protocol": "vless",
                "settings": {"clients": [{"id": uid, "email": ingress_email}], "decryption": "none"},
                "streamSettings": {"network": "tcp", "security": "none"},
            }, {
                "tag": "api",
                "listen": "0.0.0.0",
                "port": a.api_port,
                "protocol": "dokodemo-door",
                "settings": {"address": "127.0.0.1"},
            }],
            "outbounds": [{
                "tag": "fr1",
                "protocol": "vless",
                "settings": {"vnext": [{"address": a.fr1, "port": a.fr1_port, "users": [{"id": uid, "encryption": "none"}]}]},
                "streamSettings": {"network": "tcp", "security": "none"},
            }, {"tag": "block", "protocol": "blackhole"}],
            "routing": {"rules": [
                {"type": "field", "inboundTag": ["api"], "outboundTag": "api"},
                {"type": "field", "inboundTag": ["vless-fr1-relay-ingress"], "outboundTag": "fr1"},
            ]},
            "policy": {"levels": {"0": {"statsUserUplink": True, "statsUserDownlink": True}}, "system": {
                "statsInboundUplink": True, "statsInboundDownlink": True,
                "statsOutboundUplink": True, "statsOutboundDownlink": True,
            }},
        }
        upload(fr1, "/tmp/fr1-vless-relay.json", json.dumps(fr1_cfg, indent=2) + "\n")
        upload(fr1, "/tmp/fr1-vless-relay.service", unit("Dedicated VLESS TCP relay endpoint for new VPS", FR1_CONFIG, "/var/log/xray-fr1-vless-tcp-relay.log"), 0o644)
        run(fr1, f"install -m 600 /tmp/fr1-vless-relay.json {FR1_CONFIG}; install -m 644 /tmp/fr1-vless-relay.service /etc/systemd/system/{FR1_UNIT}; rm -f /tmp/fr1-vless-relay.json /tmp/fr1-vless-relay.service; {shlex.quote(fr1_xray)} run -test -config {FR1_CONFIG}; systemctl daemon-reload; systemctl enable {FR1_UNIT} >/dev/null; systemctl restart {FR1_UNIT}; if systemctl is-active --quiet ufw; then ufw allow from {a.server} to any port {a.fr1_port} proto tcp >/dev/null || true; fi; ss -ltnp | grep -E ':{a.fr1_port}([[:space:]]|$)'", 180)
        upload(relay, "/tmp/vless-fr1-relay.json", json.dumps(relay_cfg, indent=2) + "\n")
        upload(relay, "/tmp/vless-fr1-relay.service", unit("Dedicated VLESS TCP ingress forwarding to FR1", XRAY_CONFIG, "/var/log/xray-vless-tcp-fr1-relay.log"), 0o644)
        run(relay, f"install -m 600 /tmp/vless-fr1-relay.json {XRAY_CONFIG}; install -m 644 /tmp/vless-fr1-relay.service /etc/systemd/system/{XRAY_UNIT}; rm -f /tmp/vless-fr1-relay.json /tmp/vless-fr1-relay.service; {shlex.quote(xray)} run -test -config {XRAY_CONFIG}; systemctl daemon-reload; systemctl enable {XRAY_UNIT} >/dev/null; systemctl restart {XRAY_UNIT}; if systemctl is-active --quiet ufw; then ufw allow {a.listen_port}/tcp >/dev/null || true; fi; ss -ltnp | grep -E ':{a.listen_port}([[:space:]]|$)'", 180)
        link = f"vless://{uid}@{a.server}:{a.listen_port}?encryption=none&security=none&type=tcp&headerType=none#{quote('VLESS-TCP-via-FR1')}"
        print(json.dumps({"ok": True, "ingress": f"{a.server}:{a.listen_port}", "fr1Endpoint": f"{a.fr1}:{a.fr1_port}", "uuid": uid, "email": ingress_email, "apiPort": a.api_port, "fr1ApiPort": a.fr1_api_port, "link": link, "services": [XRAY_UNIT, FR1_UNIT], "ssUnchanged": True, "trafficReporterReady": True}, indent=2))
    finally:
        if relay:
            relay.close()
        if fr1:
            fr1.close()


if __name__ == "__main__":
    main()
