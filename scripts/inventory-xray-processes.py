#!/usr/bin/env python3
"""Inventory running Xray processes, including systemd and Docker ownership."""

import json
import pathlib
import re
import socket
import subprocess


def docker_names():
    try:
        output = subprocess.check_output(
            ["docker", "ps", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        return dict(line.split("\t", 1) for line in output.splitlines() if "\t" in line)
    except Exception:
        return {}


containers = docker_names()
rows = []
for proc in pathlib.Path("/proc").iterdir():
    if not proc.name.isdigit():
        continue
    try:
        comm = (proc / "comm").read_text().strip()
        argv = (proc / "cmdline").read_bytes().split(b"\0")
        args = [item.decode(errors="replace") for item in argv if item]
        executable = pathlib.Path(args[0]).name.lower() if args else ""
        if "xray" not in comm.lower() and "xray" not in executable:
            continue
        if "run" not in args and not any(item.startswith("run") for item in args[1:2]):
            continue
        cgroup = (proc / "cgroup").read_text(errors="replace")
    except Exception:
        continue

    owner = "host"
    service = re.search(r"/system\.slice/([^/]+\.service)", cgroup)
    if service:
        owner = service.group(1)
    else:
        match = re.search(r"(?:docker[-/])([0-9a-f]{12,64})", cgroup)
        if match:
            cid = match.group(1)
            owner = next((name for full, name in containers.items() if full.startswith(cid)), f"docker:{cid[:12]}")

    config = None
    for index, value in enumerate(args[:-1]):
        if value in {"-c", "-config"}:
            config = args[index + 1]
            break
    rows.append({"pid": int(proc.name), "binary": comm, "owner": owner, "config": config})

rows.sort(key=lambda item: (item["owner"], item["pid"]))
print(json.dumps({"host": socket.gethostname(), "xrayCount": len(rows), "processes": rows}))
