#!/usr/bin/env python3
"""Provision an isolated Shadowsocks Rust 2022 server over SSH.

The script is intentionally idempotent: an existing Shadowsocks config is
kept unless --rotate-key is supplied, and a non-Shadowsocks process already
using the requested port causes a safe abort.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import secrets
import shlex
import sys
from datetime import datetime, timezone
from urllib.parse import quote

try:
    import paramiko
except ImportError as exc:  # pragma: no cover - exercised on the operator host
    raise SystemExit("Missing dependency: install it with `python -m pip install paramiko`") from exc


DEFAULT_VERSION = "1.24.0"
DEFAULT_METHOD = "2022-blake3-aes-128-gcm"
SERVICE_NAME = "shadowsocks-rust"
CONFIG_PATH = "/etc/shadowsocks-rust/config.json"
UNIT_PATH = f"/etc/systemd/system/{SERVICE_NAME}.service"


def command(ssh: paramiko.SSHClient, text: str, *, timeout: int = 240) -> str:
    stdin, stdout, stderr = ssh.exec_command(text, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    status = stdout.channel.recv_exit_status()
    if status:
        raise RuntimeError(f"Remote command failed ({status}): {text}\n{err or out}")
    return out


def upload_text(ssh: paramiko.SSHClient, path: str, text: str, mode: int) -> None:
    sftp = ssh.open_sftp()
    try:
        with sftp.open(path, "w") as handle:
            handle.write(text)
        sftp.chmod(path, mode)
    finally:
        sftp.close()


def remote_arch(ssh: paramiko.SSHClient) -> str:
    arch = command(ssh, "uname -m").strip()
    mapping = {
        "x86_64": "x86_64-unknown-linux-gnu",
        "amd64": "x86_64-unknown-linux-gnu",
        "aarch64": "aarch64-unknown-linux-gnu",
        "arm64": "aarch64-unknown-linux-gnu",
    }
    if arch not in mapping:
        raise RuntimeError(f"Unsupported Linux architecture: {arch}")
    return mapping[arch]


def existing_config(ssh: paramiko.SSHClient) -> dict | None:
    sftp = ssh.open_sftp()
    try:
        with sftp.open(CONFIG_PATH, "r") as handle:
            return json.loads(handle.read().decode("utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    finally:
        sftp.close()


def make_unit() -> str:
    return f"""[Unit]
Description=Shadowsocks Rust server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/ssserver -c {CONFIG_PATH}
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Install/update isolated Shadowsocks Rust on a VPS")
    parser.add_argument("--server", required=True, help="VPS hostname or IPv4 address")
    parser.add_argument("--ssh-user", default="root")
    parser.add_argument("--ssh-port", type=int, default=22)
    parser.add_argument("--port", type=int, default=443, help="Shadowsocks TCP/UDP port")
    parser.add_argument("--version", default=DEFAULT_VERSION, help="shadowsocks-rust release version")
    parser.add_argument("--method", default=DEFAULT_METHOD)
    parser.add_argument("--rotate-key", action="store_true", help="rotate an existing server key")
    args = parser.parse_args()

    if not (1 <= args.port <= 65535):
        raise SystemExit("--port must be between 1 and 65535")

    password = os.environ.pop("SS_SSH_PASSWORD", "") or getpass.getpass(
        f"SSH password for {args.ssh_user}@{args.server}: "
    )
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(
            args.server,
            port=args.ssh_port,
            username=args.ssh_user,
            password=password,
            timeout=25,
            auth_timeout=25,
            banner_timeout=25,
            allow_agent=False,
            look_for_keys=False,
        )
        arch = remote_arch(ssh)

        # Abort before installing anything if another service owns the port.
        listeners = command(
            ssh,
            f"ss -ltnup 2>/dev/null | grep -E ':{args.port}([[:space:]]|$)' || true",
        ).strip()
        if listeners and "ssserver" not in listeners:
            raise RuntimeError(
                f"Port {args.port} is already occupied by a non-Shadowsocks process:\n{listeners}"
            )

        old = existing_config(ssh)
        if old and not args.rotate_key:
            old_method = str(old.get("method", ""))
            old_password = str(old.get("password", ""))
            if old_method and old_password and int(old.get("server_port", args.port)) == args.port:
                method = old_method
                server_key = old_password
            else:
                method = args.method
                server_key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        else:
            method = args.method
            server_key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")

        if method not in {"2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm"}:
            raise RuntimeError("This provisioner supports only Shadowsocks 2022 AES methods")

        config = {
            "server": "0.0.0.0",
            "server_port": args.port,
            "method": method,
            "password": server_key,
            "mode": "tcp_and_udp",
            "no_delay": True,
            "fast_open": False,
        }
        config_text = json.dumps(config, indent=2) + "\n"

        command(
            ssh,
            "export DEBIAN_FRONTEND=noninteractive; "
            "apt-get update -qq && apt-get install -y -qq curl ca-certificates xz-utils tar ufw",
            timeout=300,
        )
        archive = f"shadowsocks-v{args.version}.{arch}.tar.xz"
        download = (
            "set -e; "
            f"VER={shlex.quote(args.version)}; A={shlex.quote(archive)}; "
            "cd /tmp; "
            "curl -fsSL https://github.com/shadowsocks/shadowsocks-rust/releases/download/v${VER}/$A -o $A; "
            "curl -fsSL https://github.com/shadowsocks/shadowsocks-rust/releases/download/v${VER}/$A.sha256 -o $A.sha256; "
            "sha256sum -c $A.sha256; "
            "rm -rf /tmp/shadowsocks-rust-extract; mkdir -p /tmp/shadowsocks-rust-extract; "
            "tar -xJf $A -C /tmp/shadowsocks-rust-extract; "
            "install -m 0755 /tmp/shadowsocks-rust-extract/ssserver /usr/local/bin/ssserver"
        )
        command(ssh, download, timeout=300)

        if old:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            command(
                ssh,
                f"install -d -m 700 /etc/shadowsocks-rust; "
                f"cp -a {shlex.quote(CONFIG_PATH)} {shlex.quote(CONFIG_PATH + '.bak-' + stamp)} 2>/dev/null || true",
            )
        upload_text(ssh, "/tmp/shadowsocks-rust-config.json", config_text, 0o600)
        upload_text(ssh, "/tmp/shadowsocks-rust.service", make_unit(), 0o644)
        command(
            ssh,
            f"install -d -m 700 /etc/shadowsocks-rust; "
            f"install -o root -g root -m 600 /tmp/shadowsocks-rust-config.json {shlex.quote(CONFIG_PATH)}; "
            f"install -o root -g root -m 644 /tmp/shadowsocks-rust.service {shlex.quote(UNIT_PATH)}; "
            "rm -f /tmp/shadowsocks-rust-config.json /tmp/shadowsocks-rust.service; "
            "systemctl daemon-reload; systemctl enable --now shadowsocks-rust; "
            f"if systemctl is-active --quiet ufw; then ufw allow {args.port}/tcp >/dev/null; ufw allow {args.port}/udp >/dev/null; fi; "
            "systemctl is-active --quiet shadowsocks-rust; "
            f"ss -ltnup | grep -E ':{args.port}([[:space:]]|$)'",
            timeout=120,
        )

        outer = base64.urlsafe_b64encode(f"{method}:{server_key}".encode()).decode().rstrip("=")
        link = f"ss://{outer}@{args.server}:{args.port}#{quote('SS-2022-' + args.server)}"
        legacy_payload = base64.urlsafe_b64encode(
            f"{method}:{server_key}@{args.server}:{args.port}".encode()
        ).decode().rstrip("=")
        legacy_link = f"ss://{legacy_payload}#{quote('SS-2022-' + args.server)}"
        print(json.dumps({
            "ok": True,
            "server": args.server,
            "port": args.port,
            "method": method,
            "service": SERVICE_NAME,
            "link": link,
            "legacy_link": legacy_link,
            "password": server_key,
            "rotated": bool(args.rotate_key or not old),
        }, ensure_ascii=False, indent=2))
        return 0
    finally:
        ssh.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyboardInterrupt, EOFError):
        raise SystemExit("Cancelled")
