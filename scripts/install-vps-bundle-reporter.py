#!/usr/bin/env python3
"""Install the existing live Xray reporter for the new VPS bundle."""
from __future__ import annotations
import argparse, getpass, os, shlex
from pathlib import Path
import paramiko

ROOT = Path(__file__).resolve().parents[1]

def connect(host, password, port):
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=port, username='root', password=password, timeout=25, auth_timeout=25, banner_timeout=25, allow_agent=False, look_for_keys=False)
    return c

def run(c, cmd, timeout=180):
    _, out, err = c.exec_command(cmd, timeout=timeout)
    text = out.read().decode('utf-8', 'replace'); problem = err.read().decode('utf-8', 'replace')
    code = out.channel.recv_exit_status()
    if code: raise RuntimeError(problem.strip() or text.strip() or f'remote exit {code}')
    return text

def upload(c, path, text, mode):
    s = c.open_sftp()
    try:
        with s.open(path, 'w') as f: f.write(text)
        s.chmod(path, mode)
    finally: s.close()

def main():
    p=argparse.ArgumentParser(); p.add_argument('--server',required=True); p.add_argument('--ssh-port',type=int,default=22)
    p.add_argument('--node-id',required=True); p.add_argument('--api-port',type=int,default=10105); p.add_argument('--report-key',required=True)
    p.add_argument('--report-url',default='https://sub.twidu.com/internal/traffic/report'); p.add_argument('--ssh-password',default=os.getenv('SS_SSH_PASSWORD'))
    a=p.parse_args(); password=a.ssh_password or getpass.getpass(f'SSH password for root@{a.server}: ')
    reporter=(ROOT/'scripts'/'standalone-traffic-reporter.py').read_text(encoding='utf-8'); installer=(ROOT/'scripts'/'install-live-stats-traffic-reporter.sh').read_text(encoding='utf-8')
    c=connect(a.server,password,a.ssh_port)
    try:
        upload(c,'/tmp/standalone-traffic-reporter.py',reporter,0o700); upload(c,'/tmp/install-live-stats-traffic-reporter.sh',installer,0o700)
        env=f'PANEL_REPORT_URL={shlex.quote(a.report_url)}\nEDGE_REPORT_KEY={shlex.quote(a.report_key)}\n'
        upload(c,'/tmp/vps-bundle-report.env',env,0o600)
        cmd=(f"export EDGE_DIR=/opt/vpn-vps-edge-bundle TRAFFIC_NODE_ID={shlex.quote(a.node_id)} XRAY_API_PORT={a.api_port} "
             f"TRAFFIC_UNIT_NAME=xray-vps-bundle-traffic-reporter REPORT_ENV=/tmp/vps-bundle-report.env; "
             "export EDGE_DIR TRAFFIC_NODE_ID XRAY_API_PORT TRAFFIC_UNIT_NAME REPORT_ENV; "
             "bash /tmp/install-live-stats-traffic-reporter.sh")
        print(run(c,cmd),end='')
    finally: c.close()

if __name__=='__main__': main()
