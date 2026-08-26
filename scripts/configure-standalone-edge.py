#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--clients", required=True)
    parser.add_argument("--inbound-tag", required=True)
    parser.add_argument("--api-port", type=int, required=True)
    parser.add_argument("--api-listen", default="127.0.0.1")
    parser.add_argument("--flow", default="")
    return parser.parse_args()


args = parse_args()
config_path = Path(args.config)
clients_path = Path(args.clients)

config = json.loads(config_path.read_text())
clients = json.loads(clients_path.read_text())
if not isinstance(clients, list) or not clients:
    raise SystemExit("Client registry is empty")

normalized = []
seen = set()
for item in clients:
    uuid = str(item.get("uuid") or "").strip().lower()
    if not uuid or uuid in seen:
        continue
    seen.add(uuid)
    client = {
        "id": uuid,
        "email": str(
            item.get("email")
            or item.get("name")
            or f"user-{item.get('userId') or uuid[:8]}"
        ).strip(),
        "level": 0,
    }
    if args.flow:
        client["flow"] = args.flow
    normalized.append(client)

if not normalized:
    raise SystemExit("No valid UUIDs in client registry")

inbounds = config.setdefault("inbounds", [])
target = next((item for item in inbounds if item.get("tag") == args.inbound_tag), None)
if target is None:
    raise SystemExit(f"Inbound tag not found: {args.inbound_tag}")
if target.get("protocol") != "vless":
    raise SystemExit(f"Inbound is not VLESS: {args.inbound_tag}")
target.setdefault("settings", {})["clients"] = normalized

api_inbound = {
    "listen": args.api_listen,
    "port": args.api_port,
    "protocol": "dokodemo-door",
    "settings": {"address": "127.0.0.1"},
    "tag": "api",
}
inbounds[:] = [item for item in inbounds if item.get("tag") != "api"]
inbounds.append(api_inbound)

level = config.setdefault("policy", {}).setdefault("levels", {}).setdefault("0", {})
level["statsUserUplink"] = True
level["statsUserDownlink"] = True
system = config["policy"].setdefault("system", {})
system["statsInboundUplink"] = True
system["statsInboundDownlink"] = True

config["stats"] = {}
config["api"] = {
    "tag": "api",
    "services": ["StatsService", "HandlerService"],
}

routing = config.setdefault("routing", {})
rules = routing.setdefault("rules", [])
rules[:] = [
    rule
    for rule in rules
    if not (
        rule.get("type") == "field"
        and (
            "api" in (rule.get("inboundTag") or [])
            or rule.get("outboundTag") == "api"
        )
    )
]
rules.insert(
    0,
    {
        "type": "field",
        "inboundTag": ["api"],
        "outboundTag": "api",
    },
)

timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
backup = config_path.with_name(f"{config_path.name}.pre-panel-traffic-{timestamp}")
shutil.copy2(config_path, backup)

fd, temp_name = tempfile.mkstemp(prefix=f".{config_path.name}.", dir=config_path.parent)
try:
    with os.fdopen(fd, "w") as temp:
        json.dump(config, temp, indent=2)
        temp.write("\n")
    os.chmod(temp_name, 0o600)
    os.replace(temp_name, config_path)
except Exception:
    try:
        os.unlink(temp_name)
    except FileNotFoundError:
        pass
    raise

print(
    json.dumps(
        {
            "ok": True,
            "config": str(config_path),
            "backup": str(backup),
            "inboundTag": args.inbound_tag,
            "api": f"{args.api_listen}:{args.api_port}",
            "clientCount": len(normalized),
            "flow": args.flow,
        }
    )
)
