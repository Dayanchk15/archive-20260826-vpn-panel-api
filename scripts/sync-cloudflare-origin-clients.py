#!/usr/bin/env python3
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys

if len(sys.argv) != 3:
    raise SystemExit('usage: sync-cloudflare-origin-clients.py CONFIG CLIENTS_JSON')

config_path = pathlib.Path(sys.argv[1])
clients_path = pathlib.Path(sys.argv[2])
config = json.loads(config_path.read_text(encoding='utf-8'))
desired_raw = json.loads(clients_path.read_text(encoding='utf-8'))

desired = []
seen = set()
for item in desired_raw:
    uuid = str(item.get('uuid') or item.get('id') or '').strip().lower()
    if not uuid or uuid in seen:
        continue
    seen.add(uuid)
    desired.append({
        'id': uuid,
        'email': str(item.get('email') or item.get('name') or item.get('userId') or uuid),
        'level': int(item.get('level') or 0),
    })
if not desired:
    raise SystemExit('normalized client list is empty')

target_tag = os.environ.get('TARGET_INBOUND_TAG', '').strip()
target_port = int(os.environ.get('TARGET_INBOUND_PORT', '0') or 0)
targets = []
for inbound in config.get('inbounds', []):
    if inbound.get('protocol') != 'vless' or not isinstance(inbound.get('settings', {}).get('clients'), list):
        continue
    if target_tag and inbound.get('tag') != target_tag:
        continue
    if target_port and int(inbound.get('port') or 0) != target_port:
        continue
    targets.append(inbound)
if len(targets) != 1:
    raise SystemExit(f'expected exactly one VLESS client inbound, found {len(targets)}')

previous = targets[0]['settings']['clients']
previous_ids = {str(item.get('id', '')).strip().lower() for item in previous if item.get('id')}
desired_ids = {item['id'] for item in desired}
timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
backup = config_path.with_name(f'{config_path.name}.pre-cf-client-sync.{timestamp}')
temporary = config_path.with_name(f'{config_path.stem}.next.{timestamp}.json')
shutil.copy2(config_path, backup)
targets[0]['settings']['clients'] = desired
temporary.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')

try:
    subprocess.run(
        ['/usr/local/bin/xray', 'run', '-test', '-config', str(temporary)],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    temporary.replace(config_path)
except Exception:
    temporary.unlink(missing_ok=True)
    shutil.copy2(backup, config_path)
    raise

fingerprint = hashlib.sha256(','.join(sorted(desired_ids)).encode()).hexdigest()
print(json.dumps({
    'ok': True,
    'clients': len(desired_ids),
    'added': len(desired_ids - previous_ids),
    'removedStale': len(previous_ids - desired_ids),
    'fingerprint': fingerprint,
    'backup': str(backup),
}))
