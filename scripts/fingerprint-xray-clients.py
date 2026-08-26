#!/usr/bin/env python3
import hashlib
import json
import sys

config_path = sys.argv[1] if len(sys.argv) > 1 else '/opt/vpn-cloudflare-ws/config.json'
with open(config_path, encoding='utf-8') as handle:
    config = json.load(handle)
clients = config['inbounds'][0]['settings'].get('clients', [])
uuids = sorted(str(client.get('id', '')).strip().lower() for client in clients if client.get('id'))
print(json.dumps({
    'clients': len(uuids),
    'fingerprint': hashlib.sha256(','.join(uuids).encode()).hexdigest(),
}))
