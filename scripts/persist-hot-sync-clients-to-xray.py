#!/usr/bin/env python3
import datetime
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

if len(sys.argv) != 4:
    raise SystemExit('usage: persist-hot-sync-clients-to-xray.py CONFIG ENV_FILE INBOUND_TAG')

config_path = pathlib.Path(sys.argv[1])
env_path = pathlib.Path(sys.argv[2])
inbound_tag = sys.argv[3]
xray_bin = os.environ.get('XRAY_BIN', '/usr/local/bin/xray')

env_text = env_path.read_text(encoding='utf-8')
match = re.search(r'^VLESS_CLIENTS_JSON=(.*)$', env_text, flags=re.MULTILINE)
if not match:
    raise SystemExit(f'VLESS_CLIENTS_JSON missing in {env_path}')
desired = json.loads(match.group(1))
if not isinstance(desired, list) or not desired:
    raise SystemExit('desired client list is empty')

config = json.loads(config_path.read_text(encoding='utf-8'))
target = next((item for item in config.get('inbounds', []) if item.get('tag') == inbound_tag), None)
if target is None:
    raise SystemExit(f'inbound tag not found: {inbound_tag}')

clients = []
seen = set()
for item in desired:
    uuid = str(item.get('uuid', '')).strip().lower()
    if not uuid or uuid in seen:
        continue
    seen.add(uuid)
    clients.append({
        'id': uuid,
        'email': str(item.get('email') or item.get('name') or item.get('userId') or uuid),
        'level': 0,
    })
if not clients:
    raise SystemExit('normalized client list is empty')

timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
backup = config_path.with_name(f'{config_path.name}.pre-client-persist.{timestamp}')
temporary = config_path.with_name(f'{config_path.stem}.next.{timestamp}.json')
shutil.copy2(config_path, backup)
target.setdefault('settings', {})['clients'] = clients
temporary.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')

try:
    subprocess.run(
        [xray_bin, 'run', '-test', '-config', str(temporary)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    temporary.replace(config_path)
except Exception:
    temporary.unlink(missing_ok=True)
    shutil.copy2(backup, config_path)
    raise

print(json.dumps({
    'ok': True,
    'config': str(config_path),
    'inboundTag': inbound_tag,
    'clients': len(clients),
    'backup': str(backup),
    'xrayRestarted': False,
}))
