#!/usr/bin/env python3
"""Add isolated per-user SS-2022/Xray inbounds without touching shared SS 443."""
from __future__ import annotations
import argparse, base64, getpass, json, os, secrets, shlex, uuid
from pathlib import Path
import paramiko

XRAY = '/usr/local/bin/xray'
ROOT = '/opt/vpn-ss-per-user'
CONFIG = f'{ROOT}/config.json'
UNIT = 'xray-ss-per-user.service'
API_PORT = 10105
PORT_BASE = 20000
METHOD = '2022-blake3-aes-128-gcm'

def run(c, cmd, timeout=180):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode('utf-8','replace'); err = e.read().decode('utf-8','replace')
    code = o.channel.recv_exit_status()
    if code: raise RuntimeError(err.strip() or out.strip() or f'remote exit {code}')
    return out

def upload(c, path, data, mode=0o600):
    s = c.open_sftp()
    try:
        with s.open(path, 'w') as f: f.write(data)
        s.chmod(path, mode)
    finally: s.close()

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--server', required=True); p.add_argument('--ssh-port', type=int, default=22)
    p.add_argument('--clients-file', required=True); p.add_argument('--report-key', default=os.getenv('EDGE_REPORT_KEY',''))
    p.add_argument('--report-url', default='https://sub.twidu.com/internal/traffic/report')
    p.add_argument('--node-id', default='ss-per-user-193233219173'); p.add_argument('--password', default=os.getenv('SS_SSH_PASSWORD'))
    p.add_argument('--dry-run', action='store_true')
    a=p.parse_args()
    clients=json.loads(Path(a.clients_file).read_text(encoding='utf-8-sig'))
    active=[x for x in clients if str(x.get('uuid','')).strip() and str(x.get('email') or '').strip()]
    if not active: raise SystemExit('No active clients')
    # Keep stable passwords/ports across reruns when the state file is present.
    password=a.password or getpass.getpass(f'SSH password for root@{a.server}: ')
    c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(a.server, port=a.ssh_port, username='root', password=password, timeout=25, auth_timeout=25, banner_timeout=25, allow_agent=False, look_for_keys=False)
    try:
        old={}
        try:
            s=c.open_sftp()
            with s.open(f'{ROOT}/clients.json','r') as f: old=json.loads(f.read().decode())
            s.close()
        except Exception: old={}
        rows=[]; used_ports=set(); used_pw=set()
        for idx,item in enumerate(active):
            uid=str(item.get('userId') or item.get('id') or item.get('uuid')[:8])
            prior=old.get(uid,{}) if isinstance(old,dict) else {}
            port=int(prior.get('port', PORT_BASE+idx))
            while port in used_ports: port+=1
            pw=str(prior.get('password',''))
            if len(pw)<20: pw=base64.b64encode(secrets.token_bytes(16)).decode()
            while pw in used_pw: pw=base64.b64encode(secrets.token_bytes(16)).decode()
            used_ports.add(port); used_pw.add(pw)
            email=str(item.get('email') or f'user-{uid}')
            rows.append({'userId':uid,'email':email,'name':str(item.get('name') or ''),'port':port,'password':pw,'method':METHOD})
        links=[]
        for row in rows:
            payload=base64.urlsafe_b64encode(f"{METHOD}:{row['password']}".encode()).decode().rstrip('=')
            label='🇷🇺 Russia Fast'
            links.append({**row,'link':f"ss://{payload}@{a.server}:{row['port']}#{__import__('urllib.parse').parse.quote(label)}"})
        if a.dry_run:
            print(json.dumps({'ok':True,'dryRun':True,'count':len(rows),'ports':[r['port'] for r in rows]},ensure_ascii=False,indent=2)); return
        inbounds=[]
        for row in rows:
            inbounds.append({'tag':f"ss-{row['userId']}",'listen':'0.0.0.0','port':row['port'],'protocol':'shadowsocks','settings':{'method':METHOD,'password':row['password'],'network':'tcp,udp','email':row['email']},'sniffing':{'enabled':True,'destOverride':['http','tls','quic']}})
        inbounds.append({'tag':'api','listen':'127.0.0.1','port':API_PORT,'protocol':'dokodemo-door','settings':{'address':'127.0.0.1'}})
        cfg={'api':{'tag':'api','services':['StatsService','HandlerService']},'log':{'loglevel':'warning'},'stats':{},'inbounds':inbounds,'outbounds':[{'tag':'direct','protocol':'freedom'},{'tag':'block','protocol':'blackhole'}],'routing':{'rules':[{'type':'field','inboundTag':['api'],'outboundTag':'api'}]},'policy':{'levels':{'0':{'statsUserUplink':True,'statsUserDownlink':True}},'system':{'statsInboundUplink':True,'statsInboundDownlink':True,'statsOutboundUplink':True,'statsOutboundDownlink':True}}}
        unit=f'''[Unit]\nDescription=Per-user SS-2022 accounting (isolated)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={XRAY} run -config {CONFIG}\nRestart=on-failure\nRestartSec=3\nLimitNOFILE=1048576\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=full\nProtectHome=true\nStandardOutput=append:/var/log/xray-ss-per-user.log\nStandardError=append:/var/log/xray-ss-per-user.log\n\n[Install]\nWantedBy=multi-user.target\n'''
        env=f'PANEL_REPORT_URL={shlex.quote(a.report_url)}\nEDGE_REPORT_KEY={shlex.quote(a.report_key)}\n'
        run(c, f"install -d -m 700 {ROOT}; cp -a {CONFIG} {CONFIG}.bak-$(date -u +%Y%m%dT%H%M%SZ) 2>/dev/null || true")
        upload(c,'/tmp/ss-per-user-config.json',json.dumps(cfg,ensure_ascii=False,indent=2)+'\n',0o600)
        upload(c,'/tmp/ss-per-user.service',unit,0o644)
        upload(c,'/tmp/ss-per-user-clients.json',json.dumps({r['userId']:r for r in links},ensure_ascii=False,indent=2)+'\n',0o600)
        run(c,f"install -m 600 /tmp/ss-per-user-config.json {CONFIG}; install -m 644 /tmp/ss-per-user.service /etc/systemd/system/{UNIT}; install -m 600 /tmp/ss-per-user-clients.json {ROOT}/clients.json; rm -f /tmp/ss-per-user-config.json /tmp/ss-per-user.service /tmp/ss-per-user-clients.json; {XRAY} run -test -config {CONFIG}; systemctl daemon-reload; systemctl enable {UNIT} >/dev/null; systemctl restart {UNIT}; if systemctl is-active --quiet ufw; then for p in $(seq {PORT_BASE} {PORT_BASE+len(rows)}); do ufw allow $p/tcp >/dev/null || true; ufw allow $p/udp >/dev/null || true; done; fi; sleep 2; systemctl is-active --quiet {UNIT}",240)
        # Reporter is installed separately by the wrapper after smoke-checking Stats API.
        print(json.dumps({'ok':True,'server':a.server,'count':len(links),'apiPort':API_PORT,'nodeId':a.node_id,'links':links},ensure_ascii=False,indent=2))
    finally: c.close()

if __name__=='__main__': main()
