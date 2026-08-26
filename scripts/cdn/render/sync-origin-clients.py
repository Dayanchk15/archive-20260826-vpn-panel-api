#!/usr/bin/env python3
"""Merge panel-generated VLESS clients into the isolated Render FR1 origin."""
import json
import os
import shutil
import subprocess
import sys
import time

cfg = os.environ.get("CFG", "/opt/vpn-fr1-ws-7865/config.json")
unit = os.environ.get("UNIT", "xray-fr1-ws-7865.service")
xray = os.environ.get("XRAY_BIN", "/usr/local/bin/xray")
source = os.environ.get("PANEL_CLIENTS", "/tmp/render-fr1-origin-config.json")

if not os.path.isfile(cfg):
    raise SystemExit(f"missing origin config: {cfg}")
if not os.path.isfile(source):
    raise SystemExit(f"missing panel client config: {source}")

with open(cfg, encoding="utf-8") as fh:
    origin = json.load(fh)
with open(source, encoding="utf-8") as fh:
    panel = json.load(fh)

panel_inbounds = panel.get("inbounds") or []
panel_clients = (panel_inbounds[0].get("settings") or {}).get("clients") if panel_inbounds else None
if not isinstance(panel_clients, list) or not panel_clients:
    raise SystemExit("panel config contains no clients")

clients = []
seen = set()
for item in panel_clients:
    if not isinstance(item, dict):
        continue
    uuid = str(item.get("id") or "").strip().lower()
    if not uuid or uuid in seen:
        continue
    seen.add(uuid)
    client = {"id": uuid, "email": str(item.get("email") or f"user-{uuid[:8]}")}
    if item.get("level") is not None:
        client["level"] = int(item["level"])
    clients.append(client)
if not clients:
    raise SystemExit("no valid panel UUIDs")

inbounds = origin.get("inbounds") or []
if not inbounds:
    raise SystemExit("origin config contains no inbound")
inbounds[0].setdefault("settings", {})["clients"] = clients
origin["inbounds"] = inbounds

stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
backup = f"{cfg}.bak-clients-{stamp}"
shutil.copy2(cfg, backup)
tmp = f"{cfg}.tmp-{os.getpid()}.json"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(origin, fh, indent=2)
    fh.write("\n")
try:
    subprocess.run([xray, "run", "-test", "-config", tmp], check=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, cfg)
    subprocess.run(["systemctl", "restart", unit], check=True)
    subprocess.run(["systemctl", "is-active", "--quiet", unit], check=True)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)

print(json.dumps({"ok": True, "unit": unit, "clientCount": len(clients), "backup": backup}))
