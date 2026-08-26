#!/usr/bin/env python3
"""Summarize Xray inbounds and API control plane without exposing UUIDs."""

import hashlib
import json
import pathlib
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: audit-xray-control-plane.py CONFIG [TARGET_SHA256]")
        return 2
    path = pathlib.Path(sys.argv[1])
    target = sys.argv[2].lower() if len(sys.argv) > 2 else ""
    config = json.loads(path.read_text(encoding="utf-8"))
    rows = []
    for inbound in config.get("inbounds", []):
        clients = inbound.get("settings", {}).get("clients", [])
        has_target = False
        if target:
            has_target = any(
                hashlib.sha256(str(item.get("id", "")).lower().encode()).hexdigest() == target
                for item in clients
                if isinstance(item, dict)
            )
        rows.append({
            "tag": inbound.get("tag"),
            "listen": inbound.get("listen"),
            "port": inbound.get("port"),
            "protocol": inbound.get("protocol"),
            "network": inbound.get("streamSettings", {}).get("network"),
            "clients": len(clients),
            "hasTarget": has_target,
        })
    print(json.dumps({
        "path": str(path),
        "apiTag": config.get("api", {}).get("tag"),
        "apiServices": config.get("api", {}).get("services", []),
        "inbounds": rows,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
