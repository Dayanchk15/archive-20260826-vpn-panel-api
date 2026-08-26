#!/usr/bin/env python3
import datetime
import json
import pathlib
import shutil
import subprocess
import sys


if len(sys.argv) != 5:
    raise SystemExit(
        "usage: patch-tencent-xray-stats.py CONFIG CLIENTS_JSON INBOUND_TAG API_PORT"
    )

config_path = pathlib.Path(sys.argv[1])
clients_path = pathlib.Path(sys.argv[2])
inbound_tag = sys.argv[3]
api_port = int(sys.argv[4])

config = json.loads(config_path.read_text(encoding="utf-8"))
desired_raw = json.loads(clients_path.read_text(encoding="utf-8"))

clients = []
seen = set()
for item in desired_raw:
    uuid = str(item.get("uuid") or item.get("id") or "").strip().lower()
    user_id = str(item.get("userId") or "").strip()
    if not uuid or uuid in seen:
        continue
    seen.add(uuid)
    clients.append(
        {
            "id": uuid,
            "email": f"user-{user_id}" if user_id else str(item.get("email") or uuid),
            "level": 0,
        }
    )

if not clients:
    raise SystemExit("normalized client list is empty")

target = None
for inbound in config.get("inbounds", []):
    if inbound.get("tag") == inbound_tag:
        target = inbound
        break

if target is None:
    raise SystemExit(f"inbound tag not found: {inbound_tag}")
if target.get("protocol") != "vless":
    raise SystemExit(f"target inbound is not vless: {inbound_tag}")

target.setdefault("settings", {})["clients"] = clients

config["stats"] = config.get("stats") or {}
config["api"] = {
    "tag": "api",
    "services": ["HandlerService", "LoggerService", "StatsService"],
}

policy = config.setdefault("policy", {})
levels = policy.setdefault("levels", {})
levels["0"] = {
    **(levels.get("0") if isinstance(levels.get("0"), dict) else {}),
    "statsUserUplink": True,
    "statsUserDownlink": True,
}
policy["system"] = {
    **(policy.get("system") if isinstance(policy.get("system"), dict) else {}),
    "statsInboundUplink": True,
    "statsInboundDownlink": True,
    "statsOutboundUplink": True,
    "statsOutboundDownlink": True,
}

inbounds = config.setdefault("inbounds", [])
api_inbound = next((item for item in inbounds if item.get("tag") == "api"), None)
if api_inbound is None:
    inbounds.append(
        {
            "tag": "api",
            "listen": "127.0.0.1",
            "port": api_port,
            "protocol": "dokodemo-door",
            "settings": {"address": "127.0.0.1"},
        }
    )
else:
    api_inbound["listen"] = "127.0.0.1"
    api_inbound["port"] = api_port
    api_inbound["protocol"] = "dokodemo-door"
    api_inbound["settings"] = {
        **(api_inbound.get("settings") if isinstance(api_inbound.get("settings"), dict) else {}),
        "address": "127.0.0.1",
    }

routing = config.setdefault("routing", {})
routing.setdefault("domainStrategy", "AsIs")
rules = routing.setdefault("rules", [])
has_api_rule = any(
    rule.get("outboundTag") == "api"
    and "api" in [str(tag) for tag in rule.get("inboundTag", [])]
    for rule in rules
)
if not has_api_rule:
    rules.insert(0, {"type": "field", "inboundTag": ["api"], "outboundTag": "api"})

timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
backup = config_path.with_name(f"{config_path.name}.pre-te-stats.{timestamp}")
temporary = config_path.with_name(f"{config_path.stem}.next.{timestamp}.json")
shutil.copy2(config_path, backup)
temporary.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

try:
    subprocess.run(
        ["/usr/local/bin/xray", "run", "-test", "-config", str(temporary)],
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

print(
    json.dumps(
        {
            "ok": True,
            "config": str(config_path),
            "inboundTag": inbound_tag,
            "apiPort": api_port,
            "clients": len(clients),
            "backup": str(backup),
        },
        indent=2,
    )
)
