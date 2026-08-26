#!/usr/bin/env python3
"""Apply panel user UUIDs to an isolated VLESS relay ingress."""
from __future__ import annotations
import argparse, getpass, json, os, shlex
from pathlib import Path
import paramiko

CONFIG = '/opt/vpn-vless-tcp-fr1-relay/config.json'
UNIT = 'xray-vless-tcp-fr1-relay.service'

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--server', required=True)
    p.add_argument('--ssh-port', type=int, default=22)
    p.add_argument('--clients-file', required=True)
    p.add_argument('--retain-uuid', default='')
    p.add_argument('--ssh-password', default=os.getenv('VLESS_CLIENT_SYNC_SSH_PASSWORD'))
    p.add_argument('--ssh-key', default=os.getenv('VLESS_CLIENT_SYNC_SSH_KEY'))
    a = p.parse_args()
    clients = json.loads(Path(a.clients_file).read_text(encoding='utf-8-sig'))
    normalized = []
    seen = set()
    for item in clients:
        uid = str(item.get('uuid', '')).strip().lower()
        if not uid or uid in seen:
            continue
        seen.add(uid)
        normalized.append({'id': uid, 'email': str(item.get('email') or f"user-{item.get('userId', uid[:8])}").strip(), 'level': 0})
    retain = str(a.retain_uuid or '').strip().lower()
    if retain and retain not in seen:
        normalized.append({'id': retain, 'email': 'relay-provision-test', 'level': 0})
    if not normalized:
        raise SystemExit('No clients found')
    password = a.ssh_password or getpass.getpass(f'SSH password for root@{a.server}: ')
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(a.server, port=a.ssh_port, username='root', password=password, key_filename=a.ssh_key, timeout=25, auth_timeout=25, banner_timeout=25, allow_agent=not bool(password), look_for_keys=not bool(password))
    try:
        s = c.open_sftp()
        with s.open(CONFIG, 'r') as f: config = json.loads(f.read().decode())
        s.close()
        inbound = next((x for x in config.get('inbounds', []) if x.get('tag') == 'vless-fr1-relay-ingress'), None)
        if inbound is None: raise RuntimeError('ingress inbound not found')
        old = inbound.get('settings', {}).get('clients', [])
        inbound.setdefault('settings', {})['clients'] = normalized
        text = json.dumps(config, indent=2) + '\n'
        _, o, e = c.exec_command("command -v xray"); xray = o.read().decode().strip(); e.read()
        if not xray: raise RuntimeError('xray is missing')
        _, o, e = c.exec_command(f"cp -a {CONFIG} {CONFIG}.pre-client-sync-$(date -u +%Y%m%dT%H%M%SZ)"); code=o.channel.recv_exit_status(); err=e.read().decode();
        if code: raise RuntimeError(err)
        s = c.open_sftp()
        with s.open('/tmp/vless-relay-client-sync.json', 'w') as f: f.write(text)
        s.chmod('/tmp/vless-relay-client-sync.json', 0o600); s.close()
        cmd = f"install -m 600 /tmp/vless-relay-client-sync.json {CONFIG}; rm -f /tmp/vless-relay-client-sync.json; {shlex.quote(xray)} run -test -config {CONFIG}; systemctl restart {UNIT}; ok=0; for i in $(seq 1 20); do if systemctl is-active --quiet {UNIT} && ss -ltnp | grep -qE ':18443([[:space:]]|$)'; then ok=1; break; fi; sleep 1; done; if [ \"$ok\" != 1 ]; then systemctl status {UNIT} --no-pager -l || true; exit 1; fi"
        _, o, e = c.exec_command(cmd, timeout=120); out=o.read().decode(); err=e.read(); code=o.channel.recv_exit_status()
        if code: raise RuntimeError(err or out)
        print(json.dumps({'ok': True, 'server': a.server, 'clientCount': len(normalized), 'previousCount': len(old), 'service': UNIT}, indent=2))
    finally: c.close()

if __name__ == '__main__': main()
