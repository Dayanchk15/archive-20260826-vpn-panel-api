#!/usr/bin/env python3
import argparse, getpass, os, shlex
from pathlib import Path
import paramiko

ROOT=Path(__file__).resolve().parents[1]
def upload(c,path,data,mode):
 s=c.open_sftp()
 try:
  with s.open(path,'w') as f:f.write(data)
  s.chmod(path,mode)
 finally:s.close()
def main():
 p=argparse.ArgumentParser(); p.add_argument('--server',required=True); p.add_argument('--password',default=os.getenv('SS_SSH_PASSWORD')); p.add_argument('--report-key',default=os.getenv('EDGE_REPORT_KEY')); p.add_argument('--ssh-port',type=int,default=22); a=p.parse_args()
 if not a.report_key: raise SystemExit('EDGE_REPORT_KEY is missing')
 pw=a.password or getpass.getpass()
 c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy()); c.connect(a.server,port=a.ssh_port,username='root',password=pw,timeout=25,auth_timeout=25,banner_timeout=25,allow_agent=False,look_for_keys=False)
 try:
  upload(c,'/tmp/standalone-traffic-reporter.py',(ROOT/'scripts/standalone-traffic-reporter.py').read_text(encoding='utf-8'),0o700)
  upload(c,'/tmp/install-live-stats-traffic-reporter.sh',(ROOT/'scripts/install-live-stats-traffic-reporter.sh').read_text(encoding='utf-8'),0o700)
  env=f"PANEL_REPORT_URL=https://sub.twidu.com/internal/traffic/report\nEDGE_REPORT_KEY={shlex.quote(a.report_key)}\n"
  upload(c,'/tmp/ss-report.env',env,0o600)
  cmd="export EDGE_DIR=/opt/vpn-ss-per-user TRAFFIC_NODE_ID=ss-per-user-193233219173 XRAY_API_PORT=10105 TRAFFIC_UNIT_NAME=xray-ss-per-user-traffic-reporter REPORT_ENV=/tmp/ss-report.env; bash /tmp/install-live-stats-traffic-reporter.sh"
  _,o,e=c.exec_command(cmd,timeout=90); out=o.read().decode(); err=e.read().decode(); code=o.channel.recv_exit_status()
  if code: raise RuntimeError(err or out)
  print(out,end='')
 finally:c.close()
if __name__=='__main__':main()
