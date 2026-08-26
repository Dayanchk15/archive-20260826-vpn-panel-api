#!/usr/bin/env python3
import json
import os
import re
import subprocess
import time
import urllib.request


PANEL_REPORT_URL = os.environ.get("PANEL_REPORT_URL", "")
EDGE_REPORT_KEY = os.environ.get("EDGE_REPORT_KEY", "")
XRAY_BIN = os.environ.get("XRAY_BIN", "/usr/local/bin/xray")
XRAY_API_SERVER = os.environ.get("XRAY_API_SERVER", "127.0.0.1:10085")
NODE_ID = os.environ.get("TRAFFIC_NODE_ID", "standalone-edge")
INTERVAL = max(30, int(os.environ.get("TRAFFIC_REPORT_INTERVAL_SECONDS", "60")))


def read_stats():
    result = subprocess.run(
        [
            XRAY_BIN,
            "api",
            "statsquery",
            f"--server={XRAY_API_SERVER}",
            "-pattern",
            "traffic",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    )
    raw = result.stdout
    reports = {}
    try:
        stats = json.loads(raw).get("stat", [])
        for stat in stats:
            match = re.match(
                r"^user>>>(.+?)>>>traffic>>>(uplink|downlink)$",
                str(stat.get("name", "")),
            )
            if not match:
                continue
            email, direction = match.groups()
            report = reports.setdefault(
                email, {"email": email, "uploadBytes": 0, "downloadBytes": 0}
            )
            report["uploadBytes" if direction == "uplink" else "downloadBytes"] = int(
                stat.get("value", 0)
            )
    except (json.JSONDecodeError, AttributeError, TypeError, ValueError):
        pattern = re.compile(
            r'name:\s*"user>>>(.+?)>>>traffic>>>(uplink|downlink)"'
            r"[\s\S]*?value:\s*\"?(\d+)\"?"
        )
        for email, direction, value in pattern.findall(raw):
            report = reports.setdefault(
                email, {"email": email, "uploadBytes": 0, "downloadBytes": 0}
            )
            report["uploadBytes" if direction == "uplink" else "downloadBytes"] = int(
                value
            )
    return list(reports.values())


def post_reports(reports):
    if not reports:
        return
    payload = json.dumps(
        {
            "mode": "increment",
            "nodeId": NODE_ID,
            "reports": reports,
        }
    ).encode()
    request = urllib.request.Request(
        PANEL_REPORT_URL,
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-edge-report-key": EDGE_REPORT_KEY,
            "x-edge-node-id": NODE_ID,
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"Panel report returned HTTP {response.status}")


def main():
    if not PANEL_REPORT_URL or not EDGE_REPORT_KEY:
        raise SystemExit("PANEL_REPORT_URL or EDGE_REPORT_KEY is missing")
    print(
        f"Traffic reporter enabled: node={NODE_ID} api={XRAY_API_SERVER}",
        flush=True,
    )
    previous = {}
    while True:
        try:
            current = read_stats()
            deltas = []
            for item in current:
                email = item["email"]
                old = previous.get(email)
                previous[email] = {
                    "uploadBytes": item["uploadBytes"],
                    "downloadBytes": item["downloadBytes"],
                }
                if old is None:
                    continue
                upload = max(0, item["uploadBytes"] - old["uploadBytes"])
                download = max(0, item["downloadBytes"] - old["downloadBytes"])
                if upload or download:
                    deltas.append(
                        {
                            "email": email,
                            "uploadBytes": upload,
                            "downloadBytes": download,
                        }
                    )
            post_reports(deltas)
            if deltas:
                total = sum(
                    item["uploadBytes"] + item["downloadBytes"] for item in deltas
                )
                print(
                    f"Reported {total} bytes for {len(deltas)} user(s)",
                    flush=True,
                )
        except Exception as error:
            print(f"Traffic reporter error: {error}", flush=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
