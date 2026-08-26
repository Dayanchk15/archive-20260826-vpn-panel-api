import argparse, json, os, paramiko, sys
p = argparse.ArgumentParser(); p.add_argument('--server', required=True); p.add_argument('--password', default=os.getenv('SS_SSH_PASSWORD')); a = p.parse_args()
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy()); c.connect(a.server, username='root', password=a.password, timeout=20, auth_timeout=20, banner_timeout=20, allow_agent=False, look_for_keys=False)
_, out, _ = c.exec_command("python3 -c 'import json; c=json.load(open(\"/opt/vpn-vps-edge-bundle/config.json\")); print([(x[\"tag\"],x[\"port\"],len(x[\"settings\"].get(\"clients\",[]))) for x in c[\"inbounds\"] if x[\"tag\"].startswith(\"vless-\")]); print(\"SS\",sum(x[\"protocol\"]==\"shadowsocks\" for x in c[\"inbounds\"]),\"VLESS_OUT\",sum(x[\"protocol\"]==\"vless\" for x in c[\"outbounds\"]))'")
print(out.read().decode('utf-8', 'replace'))
c.close()
