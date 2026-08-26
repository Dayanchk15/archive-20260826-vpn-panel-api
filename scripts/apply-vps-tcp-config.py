#!/usr/bin/env python3
import os
import subprocess
import time

CONFIG = '/opt/vpn-relay-edge/config.json'
LISTEN = os.environ.get('EDGE_LISTEN_PORT', '8080')

def sh(cmd, check=True):
    return subprocess.run(cmd, shell=True, check=check)

def docker_edge():
    return subprocess.check_output("docker ps --format '{{.Names}}' | grep vpn-relay-edge | head -1", shell=True, text=True).strip()

if os.path.isfile('/usr/local/bin/xray') and os.access('/usr/local/bin/xray', os.X_OK):
    try:
        sh(f'/usr/local/bin/xray run -test -config {CONFIG}')
        sh("pkill -f 'xray run' 2>/dev/null || true", check=False)
        time.sleep(1)
        sh(f'nohup /usr/local/bin/xray run -c {CONFIG} >/var/log/vpn-relay-edge.log 2>&1 &')
        time.sleep(2)
        out = subprocess.check_output('ss -tlnp', shell=True, text=True)
        if f':{LISTEN}' in out:
            print('OK_BARE', LISTEN)
            raise SystemExit(0)
    except Exception as e:
        print('bare_try_failed', e)

c = docker_edge()
if not c:
    raise SystemExit('no docker edge container')
sh(f'docker cp {CONFIG} {c}:/etc/xray/config.json')
sh(f'docker restart {c}')
time.sleep(8)
out = subprocess.check_output(f'docker exec {c} ss -tlnp', shell=True, text=True)
if f':{LISTEN}' not in out:
    raise SystemExit(f'docker listen :{LISTEN} missing')
print('OK_DOCKER', c, LISTEN)
