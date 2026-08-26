#!/usr/bin/env python3
import argparse, os, paramiko, sys
sys.stdout.reconfigure(errors='replace')

p=argparse.ArgumentParser(); p.add_argument('--server',required=True); p.add_argument('--ssh-port',type=int,default=22); p.add_argument('--ssh-password',default=os.getenv('SS_SSH_PASSWORD')); a=p.parse_args()
pw=a.ssh_password
if not pw: raise SystemExit('SS_SSH_PASSWORD is required')
c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy()); c.connect(a.server,port=a.ssh_port,username='root',password=pw,timeout=20,auth_timeout=20,banner_timeout=20,allow_agent=False,look_for_keys=False)
cmds=[
 'systemctl status xray-vps-edge-bundle --no-pager -l | sed -n "1,24p"',
 'tail -80 /var/log/xray-vps-edge-bundle.log 2>/dev/null || true',
 'systemctl status xray-vps-bundle-traffic-reporter --no-pager -l | sed -n "1,20p"',
 'for spec in 185.209.230.14:18443 185.209.230.14:18444 185.209.230.14:443 185.209.230.46:8089 185.209.230.46:18444 185.209.230.46:443 130.17.12.61:443 130.17.12.61:18080 74.115.172.101:8080 74.115.172.101:9443 212.87.198.82:443; do h=${spec%:*}; p=${spec##*:}; timeout 4 bash -c "</dev/tcp/$h/$p" >/dev/null 2>&1 && echo TCP_OK:$spec || echo TCP_FAIL:$spec; done',
 'for h in fr1 fr2 fornex tampa; do code=$(curl -4 -ksS --max-time 8 --resolve ${h}.shelby-fast.site:443:212.87.198.82 -o /dev/null -w "%{http_code}" https://${h}.shelby-fast.site/ 2>/dev/null || echo ERR); echo HTTPS_${h}:$code; done',
 'ufw status verbose 2>/dev/null || true',
]
for cmd in cmds:
 print('--- '+cmd+' ---')
 _,o,e=c.exec_command(cmd,timeout=30); print(o.read().decode('utf-8','replace')); print(e.read().decode('utf-8','replace'))
c.close()
