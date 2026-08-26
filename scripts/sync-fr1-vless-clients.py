#!/usr/bin/env python3
"""Synchronize active panel UUIDs into the dedicated FR1 VLESS TCP relay.

The VPS bundle uses the same client UUID when it opens its outbound to FR1.
FR1 therefore must accept every active UUID, otherwise only the first test user
can connect through the France 1 line.  This script changes only the dedicated
relay config and restarts it only when the accepted-client set changed.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import shlex
from datetime import datetime, timezone
from pathlib import Path

import paramiko

REMOTE_DIR = "/opt/vpn-fr1-vless-tcp-relay"
REMOTE_CONFIG = f"{REMOTE_DIR}/config.json"
REMOTE_UNIT = "xray-fr1-vless-tcp-relay.service"


def connect(host: str, password: str | None, key: str | None, port: int):
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


def run(c, command: str, timeout: int = 180) -> str:
    _, out, err = c.exec_command(command, timeout=timeout)
    stdout = out.read().decode("utf-8", "replace")
    stderr = err.read().decode("utf-8", "replace")
    code = out.channel.recv_exit_status()
    if code:
        raise RuntimeError(stderr.strip() or stdout.strip() or f"remote exit {code}")
    return stdout


def upload(c, path: str, data: str, mode: int = 0o600):
    sftp = c.open_sftp()
    try:
        with sftp.open(path, "w") as handle:
            handle.write(data)
        sftp.chmod(path, mode)
    finally:
        sftp.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--fr1", default="185.209.230.14")
    p.add_argument("--ssh-port", type=int, default=22)
    p.add_argument("--clients-file", required=True)
    p.add_argument("--ssh-password", default=os.getenv("FR1_SSH_PASSWORD"))
    p.add_argument("--ssh-key", default=os.getenv("FR1_SSH_KEY", str(Path.home() / ".ssh" / "id_ed25519")))
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    raw = json.loads(Path(a.clients_file).read_text(encoding="utf-8-sig"))
    clients = []
    seen = set()
    for item in raw:
        uid = str(item.get("uuid", "")).strip().lower()
        email = str(item.get("email", "")).strip()
        if not uid or not email or item.get("status", "active") == "disabled" or uid in seen:
            continue
        seen.add(uid)
        clients.append({"id": uid, "email": email, "level": 0})
    if not clients:
        raise SystemExit("No active UUIDs in clients file")

    password = a.ssh_password
    key = None if password else a.ssh_key
    if not password and (not key or not Path(key).is_file()):
        password = getpass.getpass(f"SSH password for root@{a.fr1}: ")
        key = None
    c = connect(a.fr1, password if password else None, key, a.ssh_port)
    try:
        sftp = c.open_sftp()
        try:
            with sftp.open(REMOTE_CONFIG, "r") as handle:
                cfg = json.loads(handle.read().decode("utf-8"))
        finally:
            sftp.close()
        matched = []
        for inbound in cfg.get("inbounds", []):
            if inbound.get("port") != 18444 and inbound.get("tag") != "vless-fr1-relay-in":
                continue
            settings = inbound.setdefault("settings", {})
            old = settings.get("clients") or []
            # Preserve any non-panel relay identities while replacing the
            # generated panel identities by UUID.  This keeps the relay additive.
            panel_ids = {str(x.get("id", "")).lower() for x in clients}
            preserved = [x for x in old if str(x.get("id", "")).lower() not in panel_ids]
            old_norm = json.dumps(old, sort_keys=True)
            new = preserved + clients
            settings["clients"] = new
            matched.append({"tag": inbound.get("tag"), "before": len(old), "after": len(new), "changed": old_norm != json.dumps(new, sort_keys=True)})
        if not matched:
            raise RuntimeError("Dedicated FR1 VLESS inbound on port 18444 was not found")
        changed = any(x["changed"] for x in matched)
        result = {"ok": True, "fr1": a.fr1, "clients": len(clients), "inbounds": matched, "changed": changed, "dryRun": a.dry_run}
        if not changed or a.dry_run:
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        text = json.dumps(cfg, ensure_ascii=False, indent=2) + "\n"
        upload(c, "/tmp/fr1-vless-relay-sync.json", text)
        xray = run(c, "command -v xray || echo /usr/local/bin/xray").strip().splitlines()[-1]
        cmd = (
            f"cp -a {shlex.quote(REMOTE_CONFIG)} {shlex.quote(REMOTE_CONFIG + '.bak-' + stamp)}; "
            f"{shlex.quote(xray)} run -test -config /tmp/fr1-vless-relay-sync.json; "
            f"install -m 600 /tmp/fr1-vless-relay-sync.json {shlex.quote(REMOTE_CONFIG)}; "
            "rm -f /tmp/fr1-vless-relay-sync.json; systemctl restart " + REMOTE_UNIT + "; "
            "systemctl is-active --quiet " + REMOTE_UNIT
        )
        run(c, cmd, 180)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        c.close()


if __name__ == "__main__":
    main()
