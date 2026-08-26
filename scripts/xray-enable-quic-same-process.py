#!/usr/bin/env python3
"""Persist UDP/443 enablement without changing the running Xray process."""

import json
import os
import shutil
import sys
from datetime import datetime, timezone


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} CONFIG", file=sys.stderr)
        return 2

    path = sys.argv[1]
    with open(path, encoding="utf-8") as handle:
        config = json.load(handle)

    changed = 0
    for outbound in config.get("outbounds", []):
        if outbound.get("tag") != "block":
            continue
        if outbound.get("protocol") != "freedom":
            outbound.clear()
            outbound.update({"tag": "block", "protocol": "freedom", "settings": {}})
            changed += 1

    if not any(item.get("tag") == "block" for item in config.get("outbounds", [])):
        raise RuntimeError("outbound tag 'block' not found")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = f"{path}.pre-quic-{stamp}.bak"
    shutil.copy2(path, backup)
    temp = f"{path}.tmp-{os.getpid()}"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temp, path)
    print(json.dumps({"ok": True, "changed": changed, "backup": backup}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
