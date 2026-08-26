#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import time

CONFIG = os.environ.get('XRAY_CONFIG', '/opt/vpn-relay-edge/config.json')
PORT = os.environ.get('EDGE_PORT', '8088')

with open(CONFIG, 'r', encoding='utf-8') as f:
    config = json.load(f)

rule = {
    'type': 'field',
    'network': 'udp',
    'port': '443',
    'outboundTag': 'block',
}
block_out = {'protocol': 'blackhole', 'tag': 'block'}

outbounds = config.setdefault('outbounds', [])
if not any(o.get('tag') == 'block' for o in outbounds):
    outbounds.append(block_out)

routing = config.setdefault('routing', {'domainStrategy': 'AsIs', 'rules': []})
rules = routing.setdefault('rules', [])
if not any(
    r.get('network') == 'udp' and str(r.get('port')) == '443' and r.get('outboundTag') == 'block'
    for r in rules
):
    rules.append(rule)

with open(CONFIG, 'w', encoding='utf-8') as f:
    json.dump(config, f, indent=2)
    f.write('\n')

subprocess.run(['/usr/local/bin/xray', 'run', '-test', '-config', CONFIG], check=True)
subprocess.run(['pkill', '-f', f'xray run -c {CONFIG}'], stderr=subprocess.DEVNULL)
time.sleep(1)
with open('/var/log/vpn-relay-edge.log', 'a', encoding='utf-8'):
    pass
subprocess.Popen(
    ['/usr/local/bin/xray', 'run', '-c', CONFIG],
    stdout=open('/var/log/vpn-relay-edge.log', 'a'),
    stderr=subprocess.STDOUT,
)
time.sleep(2)
out = subprocess.check_output(['ss', '-tlnp'], text=True)
if f':{PORT}' not in out:
    raise SystemExit(f'port {PORT} not listening')
print('OK', CONFIG, 'rules', len(rules))
