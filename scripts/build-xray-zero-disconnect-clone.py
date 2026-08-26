#!/usr/bin/env python3
"""Build a validated Xray clone config with a fresh client list and API inbound."""

import json
import pathlib
import sys


if len(sys.argv) != 7:
    raise SystemExit(
        "usage: build-xray-zero-disconnect-clone.py SOURCE DEST CLIENTS_JSON "
        "INBOUND_TAG NEW_PORT API_PORT"
    )

source, dest, clients_path, inbound_tag, new_port, api_port = sys.argv[1:]
config = json.loads(pathlib.Path(source).read_text(encoding="utf-8"))
desired = json.loads(pathlib.Path(clients_path).read_text(encoding="utf-8"))
target = next((item for item in config.get("inbounds", []) if item.get("tag") == inbound_tag), None)
if target is None:
    raise SystemExit(f"inbound tag not found: {inbound_tag}")

clients = []
seen = set()
for item in desired:
    uuid = str(item.get("uuid", "")).strip().lower()
    if not uuid or uuid in seen:
        continue
    seen.add(uuid)
    clients.append({
        "id": uuid,
        "email": str(item.get("email") or item.get("name") or item.get("userId") or uuid),
        "level": 0,
    })
if not clients:
    raise SystemExit("empty normalized client list")

target["port"] = int(new_port)
target.setdefault("settings", {})["clients"] = clients
config["api"] = {"tag": "api", "services": ["HandlerService", "StatsService"]}
config["inbounds"] = [item for item in config["inbounds"] if item.get("tag") != "api-in"]
config["inbounds"].append({
    "tag": "api-in",
    "listen": "127.0.0.1",
    "port": int(api_port),
    "protocol": "dokodemo-door",
    "settings": {"address": "127.0.0.1"},
})
routing = config.setdefault("routing", {})
rules = routing.setdefault("rules", [])
rules[:] = [rule for rule in rules if "api-in" not in rule.get("inboundTag", [])]
rules.insert(0, {"type": "field", "inboundTag": ["api-in"], "outboundTag": "api"})

pathlib.Path(dest).write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"ok": True, "clients": len(clients), "port": int(new_port), "apiPort": int(api_port)}))
