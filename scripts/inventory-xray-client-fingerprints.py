#!/usr/bin/env python3
import glob
import hashlib
import json
import os

target_hash = os.environ.get('TARGET_UUID_HASH', '').strip().lower()

for config_path in sorted(glob.glob('/opt/*/config.json')):
    try:
        with open(config_path, encoding='utf-8') as handle:
            config = json.load(handle)
        for inbound in config.get('inbounds', []):
            clients = inbound.get('settings', {}).get('clients')
            if not isinstance(clients, list):
                continue
            uuids = sorted(
                str(client.get('id', '')).strip().lower()
                for client in clients
                if client.get('id')
            )
            print(json.dumps({
                'path': config_path,
                'port': inbound.get('port'),
                'network': inbound.get('streamSettings', {}).get('network'),
                'clients': len(uuids),
                'fingerprint': hashlib.sha256(','.join(uuids).encode()).hexdigest(),
                'containsTarget': any(
                    hashlib.sha256(uuid.encode()).hexdigest() == target_hash for uuid in uuids
                ) if target_hash else None,
            }))
    except Exception:
        pass
