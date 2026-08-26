#!/usr/bin/env python3
"""Install one isolated Shadowsocks-2022 inbound in a dedicated Xray unit.

The installer is intentionally independent from the panel: it only creates
``xray-ss-only.service`` and refuses to take over a port owned by another
service. Re-running it preserves the existing key unless ``--rotate-key`` is
passed.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import secrets
import shlex
import time
from urllib.parse import quote

import paramiko
from paramiko.ssh_exception import SSHException


XRAY = "/usr/local/bin/xray"
ROOT = "/opt/xray-ss-only"
CONFIG = f"{ROOT}/config.json"
UNIT = "xray-ss-only.service"
METHODS = {"2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm"}


def run(client: paramiko.SSHClient, command: str, timeout: int = 300) -> str:
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if code:
        raise RuntimeError(err.strip() or out.strip() or f"remote exit {code}")
    return out


def upload(client: paramiko.SSHClient, path: str, content: str, mode: int = 0o600) -> None:
    sftp = client.open_sftp()
    try:
        with sftp.open(path, "w") as handle:
            handle.write(content)
        sftp.chmod(path, mode)
    finally:
        sftp.close()


def connect(host: str, port: int, user: str, password: str) -> paramiko.SSHClient:
    last: Exception | None = None
    for attempt in range(1, 4):
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(
                host,
                port=port,
                username=user,
                password=password,
                timeout=45,
                auth_timeout=45,
                banner_timeout=45,
                allow_agent=False,
                look_for_keys=False,
            )
            return client
        except (OSError, SSHException) as exc:
            last = exc
            try:
                client.close()
            except Exception:
                pass
            if attempt < 3:
                time.sleep(3 * attempt)
    raise RuntimeError(f"SSH handshake failed for {host}:{port} after 3 attempts: {last}")


def existing_config(client: paramiko.SSHClient) -> dict | None:
    sftp = client.open_sftp()
    try:
        with sftp.open(CONFIG, "r") as handle:
            return json.loads(handle.read().decode("utf-8"))
    except (OSError, ValueError, FileNotFoundError):
        return None
    finally:
        sftp.close()


def install_xray(client: paramiko.SSHClient) -> None:
    if run(client, "command -v xray || true").strip():
        return
    run(client, "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq curl ca-certificates unzip", 300)
    run(
        client,
        "set -eu; arch=$(uname -m); "
        "case \"$arch\" in x86_64|amd64) asset=Xray-linux-64.zip;; "
        "aarch64|arm64) asset=Xray-linux-arm64-v8a.zip;; "
        "*) echo \"Unsupported architecture: $arch\" >&2; exit 2;; esac; "
        "cd /tmp; curl -fsSL https://github.com/XTLS/Xray-core/releases/latest/download/$asset -o xray-ss-only.zip; "
        "rm -rf xray-ss-only-extract; mkdir xray-ss-only-extract; "
        "unzip -oq xray-ss-only.zip -d xray-ss-only-extract; "
        "install -m 0755 xray-ss-only-extract/xray /usr/local/bin/xray; "
        "rm -rf xray-ss-only.zip xray-ss-only-extract",
        300,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Install isolated Xray Shadowsocks-2022")
    parser.add_argument("--server", required=True)
    parser.add_argument("--ssh-port", type=int, default=22)
    parser.add_argument("--ssh-user", default="root")
    parser.add_argument("--port", type=int, default=443)
    parser.add_argument("--method", default="2022-blake3-aes-128-gcm", choices=sorted(METHODS))
    parser.add_argument("--rotate-key", action="store_true")
    parser.add_argument("--ssh-password", default="")
    args = parser.parse_args()
    if not (1 <= args.port <= 65535):
        raise SystemExit("--port must be between 1 and 65535")

    password = args.ssh_password or os.getenv("SS_SSH_PASSWORD", "") or getpass.getpass(
        f"SSH password for {args.ssh_user}@{args.server}: "
    )
    client = connect(args.server, args.ssh_port, args.ssh_user, password)
    try:
        old = existing_config(client)
        old_port = int(old.get("inbounds", [{}])[0].get("port", 0)) if old and old.get("inbounds") else 0
        old_password = str(old.get("inbounds", [{}])[0].get("settings", {}).get("password", "")) if old else ""
        old_method = str(old.get("inbounds", [{}])[0].get("settings", {}).get("method", "")) if old else ""
        if old and not args.rotate_key and old_port == args.port and old_password and old_method in METHODS:
            method, key = old_method, old_password
        else:
            method = args.method
            key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")

        listeners = run(client, f"ss -ltnup 2>/dev/null | grep -E ':{args.port}([[:space:]]|$)' || true").strip()
        if listeners and UNIT not in listeners and "xray-ss-only" not in listeners:
            raise RuntimeError(f"Port {args.port} is already occupied by another service:\n{listeners}")

        install_xray(client)
        cfg = {
            "log": {"loglevel": "warning"},
            "inbounds": [{
                "tag": "ss-only",
                "listen": "0.0.0.0",
                "port": args.port,
                "protocol": "shadowsocks",
                "settings": {"method": method, "password": key, "network": "tcp,udp"},
            }],
            "outbounds": [{"tag": "direct", "protocol": "freedom"}],
            "routing": {"domainStrategy": "AsIs", "rules": []},
        }
        unit = f"""[Unit]
Description=Isolated Xray Shadowsocks 2022
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={XRAY} run -config {CONFIG}
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
"""
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        run(client, f"install -d -m 700 {ROOT}; test -f {CONFIG} && cp -a {CONFIG} {CONFIG}.bak-{stamp} || true")
        upload(client, "/tmp/xray-ss-only-config.json", json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
        upload(client, "/tmp/xray-ss-only.service", unit, 0o644)
        run(
            client,
            f"{XRAY} run -test -config /tmp/xray-ss-only-config.json; "
            f"install -m 600 /tmp/xray-ss-only-config.json {CONFIG}; "
            f"install -m 644 /tmp/xray-ss-only.service /etc/systemd/system/{UNIT}; "
            "rm -f /tmp/xray-ss-only-config.json /tmp/xray-ss-only.service; "
            f"systemctl daemon-reload; systemctl enable --now {UNIT}; "
            f"if systemctl is-active --quiet ufw; then ufw allow {args.port}/tcp >/dev/null; ufw allow {args.port}/udp >/dev/null; fi; "
            f"systemctl is-active --quiet {UNIT}; ss -ltnup | grep -E ':{args.port}([[:space:]]|$)'",
            180,
        )
        payload = base64.urlsafe_b64encode(f"{method}:{key}".encode()).decode().rstrip("=")
        link = f"ss://{payload}@{args.server}:{args.port}#{quote('SS Xray ' + args.server)}"
        print(json.dumps({"ok": True, "server": args.server, "port": args.port, "method": method, "service": UNIT, "link": link}, ensure_ascii=False, indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    main()
