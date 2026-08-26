#!/usr/bin/env python3
"""Read-only CDN origin runtime summary without client or secret data."""

import json
import os
import pathlib
import shutil
import socket
import subprocess
import time


def read_text(path, fallback=None):
    try:
        return pathlib.Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return fallback


def memory_summary():
    values = {}
    for line in (read_text("/proc/meminfo", "") or "").splitlines():
        key, _, raw = line.partition(":")
        if key in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
            values[key] = int(raw.strip().split()[0]) * 1024
    return values


def default_interface():
    try:
        output = subprocess.check_output(
            ["ip", "-j", "route", "show", "default"], text=True, stderr=subprocess.DEVNULL
        )
        routes = json.loads(output)
        return routes[0].get("dev") if routes else None
    except Exception:
        return None


def interface_counters(name):
    if not name:
        return None
    for line in (read_text("/proc/net/dev", "") or "").splitlines():
        if ":" not in line:
            continue
        current, raw = line.split(":", 1)
        if current.strip() != name:
            continue
        fields = [int(value) for value in raw.split()]
        return {
            "rxBytes": fields[0],
            "rxErrors": fields[2],
            "rxDropped": fields[3],
            "txBytes": fields[8],
            "txErrors": fields[10],
            "txDropped": fields[11],
        }
    return None


def socket_states():
    counts = {}
    try:
        output = subprocess.check_output(["ss", "-Htan"], text=True, stderr=subprocess.DEVNULL)
        for line in output.splitlines():
            state = line.split(None, 1)[0] if line.strip() else ""
            if state:
                counts[state] = counts.get(state, 0) + 1
    except Exception:
        pass
    return counts


def xray_resources():
    rows = []
    try:
        output = subprocess.check_output(
            ["ps", "-C", "xray", "-C", "xray-relay-v2", "-o", "pid=,pcpu=,rss=,comm="],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        for line in output.splitlines():
            pid, cpu, rss, command = line.split(None, 3)
            rows.append({"pid": int(pid), "cpuPct": float(cpu), "rssBytes": int(rss) * 1024, "name": command})
    except Exception:
        pass
    return {
        "processes": len(rows),
        "cpuPct": round(sum(row["cpuPct"] for row in rows), 2),
        "rssBytes": sum(row["rssBytes"] for row in rows),
    }


disk = shutil.disk_usage("/")
interface = default_interface()
print(json.dumps({
    "host": socket.gethostname(),
    "checkedAt": int(time.time()),
    "uptimeSeconds": float((read_text("/proc/uptime", "0") or "0").split()[0]),
    "load": list(os.getloadavg()),
    "memory": memory_summary(),
    "disk": {"totalBytes": disk.total, "freeBytes": disk.free},
    "tcp": {
        "congestionControl": read_text("/proc/sys/net/ipv4/tcp_congestion_control"),
        "qdisc": read_text("/proc/sys/net/core/default_qdisc"),
        "mtuProbing": read_text("/proc/sys/net/ipv4/tcp_mtu_probing"),
        "states": socket_states(),
    },
    "network": {"interface": interface, "counters": interface_counters(interface)},
    "xray": xray_resources(),
}, separators=(",", ":")))
