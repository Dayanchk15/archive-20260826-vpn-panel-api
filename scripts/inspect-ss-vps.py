#!/usr/bin/env python3
import argparse, getpass, json, os
import paramiko

p = argparse.ArgumentParser()
p.add_argument('--server', required=True)
p.add_argument('--port', type=int, default=22)
p.add_argument('--password', default=os.getenv('SS_SSH_PASSWORD'))
a = p.parse_args()
password = a.password or getpass.getpass()
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(a.server, port=a.port, username='root', password=password, timeout=20, auth_timeout=20, banner_timeout=20, allow_agent=False, look_for_keys=False)
try:
    cmds = {
        'ss_status': 'systemctl is-active shadowsocks-rust || true',
        'listeners': "ss -ltnup 2>/dev/null | grep -E ':443([[:space:]]|$)' || true",
        'config': "python3 - <<'PY'\nimport json\ntry:\n print(json.dumps(json.load(open('/etc/shadowsocks-rust/config.json')), ensure_ascii=False))\nexcept Exception as e: print(json.dumps({'error':str(e)}))\nPY",
        'xray': 'command -v xray || true',
        'ports': "ss -ltnup 2>/dev/null | awk 'NR>1 {print $5}' | sed -n '1,80p'",
        'xray_status': 'systemctl status xray-ss-per-user --no-pager -l 2>/dev/null | sed -n "1,18p"',
        'xray_log': 'tail -40 /var/log/xray-ss-per-user.log 2>/dev/null || true',
        'stats': "xray api statsquery --server=127.0.0.1:10105 -pattern traffic 2>/dev/null | head -c 5000 || true",
    }
    out = {}
    for k, cmd in cmds.items():
        _, stdout, stderr = c.exec_command(cmd, timeout=25)
        out[k] = stdout.read().decode('utf-8', 'replace').strip()
    print(json.dumps(out, ensure_ascii=False, indent=2))
finally:
    c.close()
