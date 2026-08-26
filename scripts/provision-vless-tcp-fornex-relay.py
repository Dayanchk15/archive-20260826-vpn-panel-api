#!/usr/bin/env python3
"""Add a VLESS TCP ingress on a VPS and route it through Fornex.

The existing Shadowsocks service is not modified.  Run after SSH to the new
VPS is reachable; set VLESS_SSH_PASSWORD or let the script prompt.
"""
import argparse, getpass, json, os, shlex, uuid
from datetime import datetime, timezone
from urllib.parse import quote
import paramiko

FORNEX = "130.17.12.61"
FORNEX_PORT = 7865
FORNEX_CONFIG = "/opt/vpn-fornex-ws-7865/config.json"
FORNEX_UNIT = "xray-fornex-ws-7865.service"
INGRESS_CONFIG = "/etc/xray/vless-tcp-fornex.json"
INGRESS_UNIT = "xray-vless-tcp-fornex.service"

def ssh(host, password=None, key=None, port=22):
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=port, username="root", password=password, key_filename=key, timeout=20,
              auth_timeout=20, banner_timeout=20, allow_agent=not bool(password),
              look_for_keys=not bool(password))
    return c

def run(c, cmd, timeout=300):
    _, out, err = c.exec_command(cmd, timeout=timeout)
    text = out.read().decode("utf-8", "replace"); problem = err.read().decode("utf-8", "replace")
    code = out.channel.recv_exit_status()
    if code: raise RuntimeError(problem.strip() or text.strip() or f"remote exit {code}")
    return text

def upload(c, path, text, mode=0o600):
    s = c.open_sftp()
    try:
        with s.open(path, "w") as f: f.write(text)
        s.chmod(path, mode)
    finally: s.close()

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--server", default="109.120.152.56")
    p.add_argument("--port", type=int, default=8443)
    p.add_argument("--ssh-port", type=int, default=22)
    p.add_argument("--fornex", default=FORNEX)
    p.add_argument("--ssh-password", default=os.getenv("VLESS_SSH_PASSWORD"))
    p.add_argument("--ssh-key", default=os.getenv("VLESS_SSH_KEY"))
    p.add_argument("--fornex-ssh-key", default=os.getenv("FORNEX_SSH_KEY", r"C:\Users\Admin\.ssh\id_ed25519"))
    a = p.parse_args()
    # A SecureString placed in $env:VLESS_SSH_PASSWORD becomes the literal
    # ``System.Security.SecureString`` and is not usable for SSH auth.
    if a.ssh_password == "System.Security.SecureString": a.ssh_password = None
    if not a.ssh_password and not a.ssh_key: a.ssh_password = getpass.getpass(f"SSH password for root@{a.server}: ")
    uid = str(uuid.uuid4()); f = n = None
    try:
        f = ssh(a.fornex, key=a.fornex_ssh_key)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        run(f, f"cp -a {FORNEX_CONFIG} {FORNEX_CONFIG}.bak-{stamp}")
        cfg = json.loads(run(f, f"cat {FORNEX_CONFIG}"))
        inbound = next((x for x in cfg.get("inbounds", []) if x.get("port") == FORNEX_PORT), None)
        if not inbound: raise RuntimeError(f"Fornex has no VLESS inbound on {FORNEX_PORT}")
        clients = inbound.setdefault("settings", {}).setdefault("clients", [])
        existing = next((x for x in clients if x.get("email") == "vless-tcp-fornex-egress"), None)
        if existing: uid = existing["id"]
        else: clients.append({"id": uid, "email": "vless-tcp-fornex-egress"})
        upload(f, "/tmp/fornex-vless.json", json.dumps(cfg, indent=2) + "\n")
        run(f, f"install -m 600 /tmp/fornex-vless.json {FORNEX_CONFIG}; rm -f /tmp/fornex-vless.json; /usr/local/bin/xray run -test -config {FORNEX_CONFIG}; systemctl restart {FORNEX_UNIT}")
        n = ssh(a.server, password=a.ssh_password, key=a.ssh_key, port=a.ssh_port)
        busy = run(n, f"ss -ltnup 2>/dev/null | grep -E ':{a.port}([[:space:]]|$)' || true").strip()
        if busy and "ssserver" not in busy: raise RuntimeError(f"port {a.port} is occupied:\n{busy}")
        run(n, "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq curl ca-certificates unzip ufw")
        run(n, "set -e; if ! command -v xray >/dev/null 2>&1; then cd /tmp; curl -fsSL https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -o xray.zip; rm -rf xray-x; mkdir xray-x; unzip -oq xray.zip -d xray-x; install -m 0755 xray-x/xray /usr/local/bin/xray; fi")
        icfg = {"log":{"loglevel":"warning"},"inbounds":[{"tag":"vless-tcp-fornex-in","listen":"0.0.0.0","port":a.port,"protocol":"vless","settings":{"clients":[{"id":uid}],"decryption":"none"},"streamSettings":{"network":"tcp","security":"none"},"sniffing":{"enabled":True,"destOverride":["http","tls","quic"]}}],"outbounds":[{"tag":"fornex-egress","protocol":"vless","settings":{"vnext":[{"address":a.fornex,"port":FORNEX_PORT,"users":[{"id":uid,"encryption":"none","security":"auto"}]}]},"streamSettings":{"network":"ws","security":"none","wsSettings":{"path":"/"}}},{"tag":"direct","protocol":"freedom"},{"tag":"block","protocol":"blackhole"}],"routing":{"rules":[{"type":"field","inboundTag":["vless-tcp-fornex-in"],"outboundTag":"fornex-egress"}]}}
        unit = f"""[Unit]\nDescription=VLESS TCP ingress via Fornex\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=/usr/local/bin/xray run -config {INGRESS_CONFIG}\nRestart=on-failure\nRestartSec=3\nLimitNOFILE=1048576\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=full\nProtectHome=true\n\n[Install]\nWantedBy=multi-user.target\n"""
        upload(n, "/tmp/vless-tcp-fornex.json", json.dumps(icfg, indent=2) + "\n")
        upload(n, "/tmp/xray-vless-tcp-fornex.service", unit, 0o644)
        run(n, f"install -d -m 755 /etc/xray; install -m 600 /tmp/vless-tcp-fornex.json {INGRESS_CONFIG}; install -m 644 /tmp/xray-vless-tcp-fornex.service /etc/systemd/system/{INGRESS_UNIT}; rm -f /tmp/vless-tcp-fornex.json /tmp/xray-vless-tcp-fornex.service; /usr/local/bin/xray run -test -config {INGRESS_CONFIG}; systemctl daemon-reload; systemctl enable --now {INGRESS_UNIT}; if systemctl is-active --quiet ufw; then ufw allow {a.port}/tcp >/dev/null; fi; ss -ltnp | grep -E ':{a.port}([[:space:]]|$)'")
        link = f"vless://{uid}@{a.server}:{a.port}?encryption=none&security=none&type=tcp&headerType=none#{quote('VLESS-TCP-Fornex')}"
        print(json.dumps({"ok":True,"server":a.server,"port":a.port,"egress":a.fornex,"link":link,"panelChanged":False,"shadowsocks443Untouched":True}, indent=2))
    finally:
        if n: n.close()
        if f: f.close()

if __name__ == "__main__": main()
