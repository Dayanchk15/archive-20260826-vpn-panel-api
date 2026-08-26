#!/usr/bin/env python3
"""Expose only the dedicated FR1 VLESS relay inbound to the new hop VPS."""
from __future__ import annotations
import argparse, getpass, json, os, shlex
import paramiko

CONFIG = '/opt/vpn-fr1-vless-tcp-relay/config.json'
UNIT = 'xray-fr1-vless-tcp-relay.service'

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--fr1', default='185.209.230.14')
    p.add_argument('--new-server', required=True)
    p.add_argument('--port', type=int, default=18444)
    p.add_argument('--ssh-key', default=os.getenv('FR1_SSH_KEY', r'C:\Users\Admin\.ssh\id_ed25519'))
    p.add_argument('--ssh-password', default=os.getenv('FR1_SSH_PASSWORD'))
    p.add_argument('--ssh-port', type=int, default=22)
    a = p.parse_args()
    password = a.ssh_password or None
    if not password and not os.path.exists(a.ssh_key):
        password = getpass.getpass(f'SSH password for root@{a.fr1}: ')
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(a.fr1, port=a.ssh_port, username='root', password=password,
              key_filename=(None if password else a.ssh_key), timeout=25,
              auth_timeout=25, banner_timeout=25, allow_agent=not bool(password),
              look_for_keys=not bool(password))
    try:
        s = c.open_sftp()
        with s.open(CONFIG, 'r') as f: cfg = json.loads(f.read().decode())
        s.close()
        inbound = next((x for x in cfg.get('inbounds', []) if x.get('tag') == 'vless-fr1-relay-in'), None)
        if inbound is None: raise RuntimeError('dedicated inbound vless-fr1-relay-in not found')
        before = inbound.get('listen')
        inbound['listen'] = '0.0.0.0'
        text = json.dumps(cfg, indent=2) + '\n'
        s = c.open_sftp(); s.open('/tmp/fr1-vless-bind-repair.json', 'w').write(text); s.chmod('/tmp/fr1-vless-bind-repair.json', 0o600); s.close()
        cmd = (
            f"cp -a {CONFIG} {CONFIG}.pre-bind-repair-$(date -u +%Y%m%dT%H%M%SZ); "
            f"install -m 600 /tmp/fr1-vless-bind-repair.json {CONFIG}; rm -f /tmp/fr1-vless-bind-repair.json; "
            f"xray run -test -config {CONFIG}; systemctl restart {UNIT}; "
            f"if systemctl is-active --quiet ufw; then ufw allow from {shlex.quote(a.new_server)} to any port {a.port} proto tcp >/dev/null || true; fi; "
            f"sleep 2; systemctl is-active --quiet {UNIT}; ss -ltnp | grep -E ':{a.port}([[:space:]]|$)'"
        )
        _, o, e = c.exec_command(cmd, timeout=90); out=o.read().decode(); err=e.read(); code=o.channel.recv_exit_status()
        if code: raise RuntimeError(err or out)
        print(json.dumps({'ok': True, 'fr1': a.fr1, 'inbound': 'vless-fr1-relay-in', 'beforeListen': before, 'afterListen': '0.0.0.0', 'port': a.port, 'newServerAllowed': a.new_server, 'output': out.strip()}, indent=2))
    finally:
        c.close()

if __name__ == '__main__': main()
