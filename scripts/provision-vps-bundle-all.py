#!/usr/bin/env python3
"""Install an isolated per-user SS + multi-egress VLESS bundle on a new VPS.

The script never edits or restarts an existing service.  It creates one new
Xray unit with per-user SS ports and four VLESS TCP ingress ports, each routed
to a separately configured VLESS egress.  The egress profiles must describe
the actual reachable origins; no guessed credentials are generated for remote
servers.  A JSON link map is written locally for the panel registration step.
"""
from __future__ import annotations

import argparse, base64, getpass, json, os, secrets, shlex, socket, uuid
from pathlib import Path
from urllib.parse import quote

import paramiko
from paramiko.ssh_exception import SSHException

XRAY = "/usr/local/bin/xray"
ROOT = "/opt/vpn-vps-edge-bundle"
CONFIG = f"{ROOT}/config.json"
UNIT = "xray-vps-edge-bundle.service"
API_PORT = 10105
SS_METHOD = "2022-blake3-aes-128-gcm"


def connect(host: str, password: str, port: int, username: str):
    last = None
    # A fresh VPS can briefly reset the first SSH handshake while cloud-init,
    # sshd or provider anti-brute-force rules are settling. Retry only the
    # connection; no remote command has run yet, so this is side-effect free.
    for attempt in range(1, 4):
        c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            c.connect(host, port=port, username=username, password=password, timeout=60,
                      auth_timeout=60, banner_timeout=60, allow_agent=False, look_for_keys=False)
            return c
        except (OSError, SSHException) as exc:
            last = exc
            try: c.close()
            except Exception: pass
            if attempt < 3:
                import time
                time.sleep(5 * attempt)
    raise RuntimeError(f"SSH handshake failed for {host}:{port} after 3 attempts: {last}")


def run(c, cmd: str, timeout=300):
    _, out, err = c.exec_command(cmd, timeout=timeout)
    stdout = out.read().decode("utf-8", "replace")
    stderr = err.read().decode("utf-8", "replace")
    code = out.channel.recv_exit_status()
    if code: raise RuntimeError(stderr.strip() or stdout.strip() or f"remote exit {code}")
    return stdout


def upload(c, path: str, text: str, mode=0o600):
    s = c.open_sftp()
    try:
        with s.open(path, "w") as f: f.write(text)
        s.chmod(path, mode)
    finally: s.close()


def ensure_xray(c):
    found = run(c, "command -v xray || true").strip()
    if found: return found
    run(c, "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq curl ca-certificates unzip", 300)
    run(c, "set -e; cd /tmp; curl -fsSL https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -o xray-bundle.zip; rm -rf xray-bundle-x; mkdir xray-bundle-x; unzip -oq xray-bundle.zip -d xray-bundle-x; install -m 0755 xray-bundle-x/xray /usr/local/bin/xray; rm -rf xray-bundle.zip xray-bundle-x", 300)
    return XRAY


def stream_settings(profile):
    network = profile.get("network", "tcp")
    security = profile.get("security", "none")
    s = {"network": network, "security": security}
    if security == "tls":
        tls = {"serverName": profile.get("sni") or profile.get("host"), "allowInsecure": False}
        if profile.get("alpn"): tls["alpn"] = profile["alpn"]
        s["tlsSettings"] = tls
    if network == "ws":
        s["wsSettings"] = {"path": profile.get("path") or "/", "headers": {"Host": profile.get("hostHeader") or profile.get("host")}}
    return s


def normalize_egresses(path: Path):
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(raw, list) or len(raw) != 4: raise SystemExit("Egress config must contain exactly four profiles: fr1, fr2, fornex, tampa")
    result = []
    seen = set()
    for item in raw:
        if not isinstance(item, dict): raise SystemExit("Invalid egress profile")
        eid = str(item.get("id", "")).strip().lower()
        if eid not in {"fr1", "fr2", "fornex", "tampa"} or eid in seen: raise SystemExit(f"Invalid/duplicate egress id: {eid}")
        host = str(item.get("host", "")).strip(); port = int(item.get("port", 0))
        if not host or not (1 <= port <= 65535): raise SystemExit(f"Invalid egress endpoint for {eid}")
        network = str(item.get("network", "tcp")).strip().lower(); security = str(item.get("security", "none")).strip().lower()
        if network not in {"tcp", "ws"} or security not in {"none", "tls"}: raise SystemExit(f"Unsupported transport for {eid}: {network}/{security}")
        if network == "ws" and not str(item.get("path", "")).startswith("/"): raise SystemExit(f"WS path is required for {eid}")
        if security == "tls" and not str(item.get("sni", "")).strip(): raise SystemExit(f"TLS SNI is required for {eid}")
        result.append({**item, "id": eid, "host": host, "port": port, "network": network, "security": security})
        seen.add(eid)
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--server", required=True); p.add_argument("--ssh-port", type=int, default=22); p.add_argument("--ssh-user", default="root")
    p.add_argument("--clients-file", required=True); p.add_argument("--egress-config", required=True)
    p.add_argument("--map-out", required=True); p.add_argument("--report-key", default=os.getenv("EDGE_REPORT_KEY", ""))
    p.add_argument("--retire-server", action="append", default=[], help="Old bundle IP to remove from client subscriptions")
    p.add_argument("--report-url", default="https://sub.twidu.com/internal/traffic/report")
    # 20000/20001 are reserved legacy slots; published bundle SS links start
    # at 20002 (the recovery/sync path uses the same base).
    p.add_argument("--node-id", default=""); p.add_argument("--ss-port-base", type=int, default=20002)
    p.add_argument("--vless-port-base", type=int, default=21000); p.add_argument("--ssh-password", default=os.getenv("SS_SSH_PASSWORD"))
    a = p.parse_args()
    clients_raw = json.loads(Path(a.clients_file).read_text(encoding="utf-8-sig"))
    clients = [x for x in clients_raw if str(x.get("uuid", "")).strip() and str(x.get("email", "")).strip() and x.get("status", "active") != "disabled"]
    if not clients: raise SystemExit("No active clients in clients file")
    egresses = normalize_egresses(Path(a.egress_config))
    password = a.ssh_password or getpass.getpass(f"SSH password for root@{a.server}: ")
    node_id = a.node_id or "vps-bundle-" + a.server.replace(".", "")
    if not (1 <= a.ss_port_base <= 65535 and 1 <= a.vless_port_base <= 65535): raise SystemExit("Invalid port base")
    if a.ss_port_base + len(clients) > 65535 or a.vless_port_base + len(egresses) > 65535: raise SystemExit("Port range exceeds 65535")

    rows = []
    for idx, item in enumerate(clients):
        uid = str(item["uuid"]).strip().lower(); email = str(item["email"]).strip()
        ss_pw = base64.b64encode(secrets.token_bytes(16)).decode()
        ss_port = a.ss_port_base + idx
        ss_payload = base64.urlsafe_b64encode(f"{SS_METHOD}:{ss_pw}".encode()).decode().rstrip("=")
        row = {"userId": str(item.get("userId") or item.get("id") or uid[:8]), "email": email, "uuid": uid,
               "ssPort": ss_port, "ssPassword": ss_pw,
               "ssLink": f"ss://{ss_payload}@{a.server}:{ss_port}#{quote('🇷🇺 Russia Moscow')}"}
        row["vlessLinks"] = []
        for j, e in enumerate(egresses):
            port = a.vless_port_base + j
            # The client-facing listener on the bundle VPS is always plain VLESS/TCP.
            # Egress TLS/WS belongs to the VPS outbound and must not be copied into
            # the client URI; doing so makes clients attempt TLS against a raw VLESS
            # listener and results in an immediate timeout.
            params = ["encryption=none", "security=none", "type=tcp", "headerType=none"]
            row["vlessLinks"].append({"egress": e["id"], "link": f"vless://{uid}@{a.server}:{port}?{'&'.join(params)}#{quote(str(e.get('label') or e['id']))}"})
        rows.append(row)

    inbounds = []
    for row in rows:
        inbounds.append({"tag": f"ss-{row['userId']}", "listen": "0.0.0.0", "port": row["ssPort"], "protocol": "shadowsocks",
                         "settings": {"method": SS_METHOD, "password": row["ssPassword"], "network": "tcp,udp", "email": row["email"]},
                         "sniffing": {"enabled": True, "destOverride": ["http", "tls", "quic"]}})
    for j, e in enumerate(egresses):
        inbounds.append({"tag": f"vless-{e['id']}", "listen": "0.0.0.0", "port": a.vless_port_base + j, "protocol": "vless",
                         "settings": {"clients": [{"id": r["uuid"], "email": r["email"], "level": 0} for r in rows], "decryption": "none"},
                         "streamSettings": {"network": "tcp", "security": "none"}})
    inbounds.append({"tag": "api", "listen": "127.0.0.1", "port": API_PORT, "protocol": "dokodemo-door", "settings": {"address": "127.0.0.1"}})
    # Xray requires exactly one user per VLESS outbound.  Build a dedicated
    # outbound for every (egress, client) pair and route by the inbound email.
    outbounds = [
        {"tag": "api", "protocol": "blackhole"},
        {"tag": "direct", "protocol": "freedom", "settings": {}},
    ]
    outbound_tags = {}
    for e in egresses:
        for idx, r in enumerate(rows):
            tag = f"{e['id']}-{idx}"
            outbound_tags[(e["id"], r["email"])] = tag
            outbounds.append({"tag": tag, "protocol": "vless", "settings": {"vnext": [{"address": e["host"], "port": e["port"], "users": [{"id": r["uuid"], "encryption": "none"}]}]}, "streamSettings": stream_settings(e)})
    outbounds.append({"tag": "block", "protocol": "blackhole"})
    rules = [{"type": "field", "inboundTag": ["api"], "outboundTag": "api"}]
    # The Moscow Shadowsocks listeners must use this VPS as their exit node.
    # Keep an explicit rule because the first outbound is reserved for the
    # local Stats API and must never become the default for client traffic.
    for r in rows:
        rules.append({"type": "field", "inboundTag": [f"ss-{r['userId']}"], "outboundTag": "direct"})
    for e in egresses:
        for r in rows:
            rules.append({"type": "field", "inboundTag": [f"vless-{e['id']}"], "user": [r["email"]], "outboundTag": outbound_tags[(e["id"], r["email"])]})
        rules.append({"type": "field", "inboundTag": [f"vless-{e['id']}"], "outboundTag": "block"})
    cfg = {"api": {"tag": "api", "services": ["StatsService", "HandlerService"]}, "log": {"loglevel": "warning"}, "stats": {},
           "inbounds": inbounds, "outbounds": outbounds, "routing": {"domainStrategy": "AsIs", "rules": rules},
           "policy": {"levels": {"0": {"statsUserUplink": True, "statsUserDownlink": True}}, "system": {"statsInboundUplink": True, "statsInboundDownlink": True, "statsOutboundUplink": True, "statsOutboundDownlink": True}}}
    unit = f"""[Unit]\nDescription=Isolated per-user SS and VLESS multi-egress bundle\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={XRAY} run -config {CONFIG}\nRestart=on-failure\nRestartSec=3\nLimitNOFILE=1048576\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=full\nProtectHome=true\nStandardOutput=append:/var/log/xray-vps-edge-bundle.log\nStandardError=append:/var/log/xray-vps-edge-bundle.log\n\n[Install]\nWantedBy=multi-user.target\n"""
    c = None
    try:
        c = connect(a.server, password, a.ssh_port, a.ssh_user); xray = ensure_xray(c)
        ports = [a.ss_port_base + i for i in range(len(clients))] + [a.vless_port_base + i for i in range(len(egresses))] + [API_PORT]
        port_expr = "|".join(str(x) for x in ports)
        busy = run(c, f"ss -ltnup 2>/dev/null | grep -E ':({port_expr})([[:space:]]|$)' || true").strip()
        if busy and UNIT not in busy: raise RuntimeError(f"One or more requested ports are already occupied:\n{busy}")
        stamp = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        run(c, f"install -d -m 700 {ROOT}; test -f {CONFIG} && cp -a {CONFIG} {CONFIG}.bak-{stamp} || true")
        upload(c, "/tmp/vps-bundle-config.json", json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", 0o600)
        upload(c, "/tmp/vps-bundle.service", unit, 0o644)
        run(c, f"{xray} run -test -config /tmp/vps-bundle-config.json; install -m 600 /tmp/vps-bundle-config.json {CONFIG}; install -m 644 /tmp/vps-bundle.service /etc/systemd/system/{UNIT}; rm -f /tmp/vps-bundle-config.json /tmp/vps-bundle.service; systemctl daemon-reload; systemctl enable {UNIT} >/dev/null; systemctl restart {UNIT}; sleep 2; systemctl is-active --quiet {UNIT}; ss -ltnp | grep -E ':({port_expr})([[:space:]]|$)'", 240)
        run(c, f"if systemctl is-active --quiet ufw; then ufw allow {a.ss_port_base}:{a.ss_port_base + len(clients)-1}/tcp >/dev/null; ufw allow {a.ss_port_base}:{a.ss_port_base + len(clients)-1}/udp >/dev/null; ufw allow {a.vless_port_base}:{a.vless_port_base + len(egresses)-1}/tcp >/dev/null; fi")
        upload(c, f"{ROOT}/links.json", json.dumps({"server": a.server, "nodeId": node_id, "links": rows, "egresses": egresses}, ensure_ascii=False, indent=2) + "\n", 0o600)
        Path(a.map_out).write_text(json.dumps({"server": a.server, "nodeId": node_id, "links": rows, "egresses": egresses, "retiredServerIps": [x.strip() for x in a.retire_server if x.strip()]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"ok": True, "server": a.server, "nodeId": node_id, "activeClients": len(rows), "ssPorts": len(rows), "vlessEgresses": [e["id"] for e in egresses], "service": UNIT, "apiPort": API_PORT, "reporterReady": bool(a.report_key)}, ensure_ascii=False, indent=2))
    finally:
        if c: c.close()


if __name__ == "__main__": main()
