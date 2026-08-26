#!/usr/bin/env python3
import argparse, base64, getpass, json, os
from pathlib import Path
import paramiko

METHOD='2022-blake3-aes-128-gcm'
def main():
    p=argparse.ArgumentParser(); p.add_argument('--server',required=True); p.add_argument('--out',required=True); p.add_argument('--password',default=os.getenv('SS_SSH_PASSWORD')); p.add_argument('--ssh-port',type=int,default=22); a=p.parse_args()
    pw=a.password or getpass.getpass()
    c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy()); c.connect(a.server,port=a.ssh_port,username='root',password=pw,timeout=25,auth_timeout=25,banner_timeout=25,allow_agent=False,look_for_keys=False)
    try:
        s=c.open_sftp()
        with s.open('/opt/vpn-ss-per-user/clients.json','r') as f: rows=json.loads(f.read().decode())
        s.close()
        links=[]
        from urllib.parse import quote
        for row in rows.values():
            payload=base64.urlsafe_b64encode(f"{row['method']}:{row['password']}".encode()).decode().rstrip('=')
            links.append({**row,'link':f"ss://{payload}@{a.server}:{row['port']}#{quote('🇷🇺 Russia Fast')}"})
        Path(a.out).write_text(json.dumps({'ok':True,'server':a.server,'nodeId':'ss-per-user-'+a.server.replace('.',''),'links':links},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({'ok':True,'count':len(links),'output':a.out},ensure_ascii=False))
    finally: c.close()
if __name__=='__main__': main()
