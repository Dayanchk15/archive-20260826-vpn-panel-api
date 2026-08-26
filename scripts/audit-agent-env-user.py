#!/usr/bin/env python3
"""Report whether an edge-agent persisted client list contains a UUID hash."""

import hashlib
import json
import pathlib
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: audit-agent-env-user.py TARGET_SHA256 ENV_FILE...")
        return 2
    target = sys.argv[1].lower()
    for raw_path in sys.argv[2:]:
        path = pathlib.Path(raw_path)
        found = False
        count = 0
        try:
            line = next(
                line for line in path.read_text(encoding="utf-8").splitlines()
                if line.startswith("VLESS_CLIENTS_JSON=")
            )
            clients = json.loads(line.split("=", 1)[1])
            count = len(clients) if isinstance(clients, list) else 0
            found = any(
                hashlib.sha256(str(item.get("uuid", "")).lower().encode()).hexdigest() == target
                for item in clients
                if isinstance(item, dict)
            )
            print(json.dumps({"path": str(path), "clients": count, "hasTarget": found}))
        except Exception as exc:
            print(json.dumps({"path": str(path), "error": str(exc)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
