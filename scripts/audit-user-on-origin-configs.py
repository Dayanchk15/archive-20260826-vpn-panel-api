#!/usr/bin/env python3
import hashlib
import json
import os
import pathlib
import sys

target = sys.argv[1]
rows = []
for root, dirs, files in os.walk('/opt'):
    dirs[:] = [item for item in dirs if item not in {'node_modules', 'backups'}]
    for filename in files:
        if filename != 'config.json':
            continue
        path = pathlib.Path(root) / filename
        try:
            config = json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            continue
        ids = []
        for inbound in config.get('inbounds', []):
            for client in inbound.get('settings', {}).get('clients', []):
                uuid = str(client.get('id', '')).strip().lower()
                if uuid:
                    ids.append(uuid)
        if not ids:
            continue
        hashes = {hashlib.sha256(value.encode()).hexdigest() for value in ids}
        rows.append({'path': str(path), 'clients': len(set(ids)), 'hasTarget': target in hashes})
print(json.dumps({'targetHash': target, 'configs': rows}, indent=2))
