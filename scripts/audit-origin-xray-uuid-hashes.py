#!/usr/bin/env python3
import hashlib
import json
import sys

config_path = sys.argv[1]
port = int(sys.argv[2])
with open(config_path, encoding="utf-8") as handle:
    config = json.load(handle)

inbound = next(
    item for item in config.get("inbounds", [])
    if int(item.get("port", 0)) == port and item.get("protocol") == "vless"
)
hashes = sorted({
    hashlib.sha256(str(client.get("id", "")).encode()).hexdigest()
    for client in inbound.get("settings", {}).get("clients", [])
    if client.get("id")
})
print(json.dumps({"port": port, "count": len(hashes), "hashes": hashes}))
