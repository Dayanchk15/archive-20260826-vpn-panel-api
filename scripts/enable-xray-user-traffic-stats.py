#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
import time


PLANS = {
    "vmi3425522": [
        ("/opt/vpn-fr1-bunny-xhttp2/config.json", "xray-fr1-bunny-xhttp2-pilot.service", "/opt/vpn-fr1-bunny-xhttp2/xray"),
        ("/opt/vpn-relay-edge-v2/config.json", "xray-relay-v2.service", "/usr/local/bin/xray-relay-v2"),
    ],
    "vmi3425523": [
        ("/opt/vpn-fr2-bunny-ws/config.json", "xray-fr2-bunny-ws.service", "/usr/local/bin/xray"),
        ("/opt/vpn-dayanch-bunny-xhttp/config.json", "xray-dayanch-bunny-xhttp.service", "/opt/vpn-dayanch-bunny-xhttp/xray-26.3.27"),
        ("/opt/vpn-fr2-cloudflare-grpc/config.json", "xray-fr2-cloudflare-grpc.service", "/usr/local/bin/xray"),
        ("/opt/vpn-relay-edge-v2/config.json", "xray-relay-v2.service", "/usr/local/bin/xray-relay-v2"),
    ],
    "musing-poitras.hivelocitydns.com": [
        ("/opt/vpn-tampa-bunny-ws/config.json", "xray-tampa-bunny-ws.service", "/usr/local/bin/xray"),
        ("/opt/vpn-dayanch-bunny-xhttp/config.json", "xray-dayanch-bunny-xhttp.service", "/opt/vpn-dayanch-bunny-xhttp/xray-26.3.27"),
        ("/opt/vpn-tampa-cloudflare-grpc/config.json", "xray-tampa-cloudflare-grpc.service", "/usr/local/bin/xray"),
        ("/opt/vpn-relay-edge-v2/config.json", "xray-relay-v2.service", "/usr/local/bin/xray-relay-v2"),
    ],
}


def main():
    host = os.uname().nodename
    if host not in PLANS:
        raise SystemExit(f"unknown host {host}")

    changed = []
    for config_path, unit, xray_bin in PLANS[host]:
        if not os.path.exists(config_path):
            print("SKIP missing", config_path)
            continue

        with open(config_path, "r", encoding="utf-8") as handle:
            before = handle.read()
        config = json.loads(before)

        config.setdefault("stats", {})
        policy = config.setdefault("policy", {})
        system = policy.setdefault("system", {})
        for key in (
            "statsInboundUplink",
            "statsInboundDownlink",
            "statsOutboundUplink",
            "statsOutboundDownlink",
        ):
            system[key] = True

        levels = policy.setdefault("levels", {})
        for level in ("0", "8"):
            levels.setdefault(level, {})
            levels[level]["statsUserUplink"] = True
            levels[level]["statsUserDownlink"] = True

        after = json.dumps(config, indent=2) + "\n"
        if before == after:
            print("UNCHANGED", unit)
            continue

        backup = f"{config_path}.backup-before-user-stats-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(config_path, backup)
        with open(config_path, "w", encoding="utf-8") as handle:
            handle.write(after)

        subprocess.run([xray_bin, "run", "-test", "-c", config_path], check=True, stdout=subprocess.DEVNULL)
        changed.append(unit)
        print("PATCHED", unit, backup)

    for unit in changed:
        subprocess.run(["systemctl", "restart", unit], check=True)

    for unit in changed:
        subprocess.run(["systemctl", "is-active", unit], check=True, stdout=subprocess.DEVNULL)
        print("ACTIVE", unit)

    return 0


if __name__ == "__main__":
    sys.exit(main())
