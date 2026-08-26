#!/usr/bin/env python3
"""Install the existing Xray traffic reporter on an isolated VLESS ingress VPS."""
from __future__ import annotations

import argparse
import getpass
import os
import shlex
from pathlib import Path

import paramiko


ROOT = Path(__file__).resolve().parents[1]
REPORTER = ROOT / "scripts" / "standalone-traffic-reporter.py"
INSTALLER = ROOT / "scripts" / "install-standalone-traffic-reporter.sh"


def connect(host: str, password: str | None, key: str | None, port: int):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, port=port, username="root", password=password,
                   key_filename=key, timeout=25, auth_timeout=25,
                   banner_timeout=25, allow_agent=not bool(password),
                   look_for_keys=not bool(password))
    return client


def run(client, command: str, timeout: int = 180):
    _, out, err = client.exec_command(command, timeout=timeout)
    stdout = out.read().decode("utf-8", "replace")
    stderr = err.read().decode("utf-8", "replace")
    code = out.channel.recv_exit_status()
    if code:
        raise RuntimeError(stderr.strip() or stdout.strip() or f"remote exit {code}")
    return stdout


def upload(client, remote: str, data: str, mode: int):
    sftp = client.open_sftp()
    try:
        with sftp.open(remote, "w") as handle:
            handle.write(data)
        sftp.chmod(remote, mode)
    finally:
        sftp.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--server", required=True)
    p.add_argument("--ssh-port", type=int, default=22)
    p.add_argument("--api-port", type=int, default=10095)
    p.add_argument("--node-id", required=True)
    p.add_argument("--report-url", default="https://sub.twidu.com/internal/traffic/report")
    p.add_argument("--ssh-password", default=os.getenv("TRAFFIC_REPORTER_SSH_PASSWORD"))
    p.add_argument("--ssh-key", default=os.getenv("TRAFFIC_REPORTER_SSH_KEY"))
    p.add_argument("--report-key", default=os.getenv("EDGE_REPORT_KEY"))
    a = p.parse_args()
    if not REPORTER.is_file() or not INSTALLER.is_file():
        raise SystemExit("reporter source files are missing")
    password = a.ssh_password or getpass.getpass(f"SSH password for root@{a.server}: ")
    report_key = a.report_key or getpass.getpass("EDGE_REPORT_KEY (hidden): ")
    client = None
    try:
        client = connect(a.server, password, a.ssh_key, a.ssh_port)
        run(client, "command -v xray >/dev/null && command -v python3 >/dev/null")
        upload(client, "/tmp/standalone-traffic-reporter.py", REPORTER.read_text(encoding="utf-8"), 0o700)
        upload(client, "/tmp/install-standalone-traffic-reporter.sh", INSTALLER.read_text(encoding="utf-8"), 0o700)
        env = "\n".join([
            f"PANEL_REPORT_URL={shlex.quote(a.report_url)}",
            f"EDGE_REPORT_KEY={shlex.quote(report_key)}",
        ]) + "\n"
        upload(client, "/tmp/pilot-report.env", env, 0o600)
        cmd = " ".join([
            "export", f"EDGE_DIR={shlex.quote('/opt/vpn-vless-tcp-fr1-relay')}",
            f"TRAFFIC_NODE_ID={shlex.quote(a.node_id)}",
            f"XRAY_API_PORT={a.api_port}",
            "TRAFFIC_UNIT_NAME=xray-vless-tcp-fr1-traffic-reporter",
            ";", "export", "EDGE_DIR TRAFFIC_NODE_ID XRAY_API_PORT TRAFFIC_UNIT_NAME", ";",
            "bash /tmp/install-standalone-traffic-reporter.sh",
        ])
        output = run(client, cmd, 180)
        print(output, end="")
    finally:
        if client:
            client.close()


if __name__ == "__main__":
    main()
