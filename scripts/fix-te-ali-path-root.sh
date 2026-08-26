#!/bin/bash
# Fix TE xray path to "/" on one edge. Keep separate ALI xray.
# Usage: bash fix-te-ali-path-root.sh <role>
# role: fr1|fr2|fornex|tampa
set -euo pipefail
ROLE="${1:?role}"

case "$ROLE" in
  fr1)
    TE_DIR=/opt/vpn-fr1-tencent-ws
    TE_UNIT=xray-fr1-tencent-ws
    ALI_DIR=/opt/vpn-fr1-alibaba-ws
    ALI_UNIT=xray-fr1-alibaba-ws
    TE_PORT=18111
    ALI_PORT=18110
    TE_LISTEN=127.0.0.1
    ALI_LISTEN=127.0.0.1
    ;;
  fr2)
    TE_DIR=/opt/vpn-fr2-tencent-ws
    TE_UNIT=xray-fr2-tencent-ws
    ALI_DIR=/opt/vpn-fr2-alibaba-ws
    ALI_UNIT=xray-fr2-alibaba-ws
    TE_PORT=18109
    ALI_PORT=18108
    TE_LISTEN=0.0.0.0
    ALI_LISTEN=0.0.0.0
    ;;
  fornex)
    TE_DIR=/opt/vpn-fornex-tencent-ws
    TE_UNIT=xray-fornex-tencent-ws
    ALI_DIR=/opt/vpn-fornex-alibaba-ws
    ALI_UNIT=xray-fornex-alibaba-ws
    TE_PORT=18109
    ALI_PORT=18108
    TE_LISTEN=0.0.0.0
    ALI_LISTEN=0.0.0.0
    ;;
  tampa)
    TE_DIR=/opt/vpn-tampa-tencent-ws
    TE_UNIT=xray-tampa-tencent-ws
    ALI_DIR=/opt/vpn-tampa-alibaba-ws
    ALI_UNIT=xray-tampa-alibaba-ws
    TE_PORT=18109
    ALI_PORT=18108
    TE_LISTEN=0.0.0.0
    ALI_LISTEN=0.0.0.0
    ;;
  *) echo "bad role"; exit 1 ;;
esac

python3 - <<PY
import json, pathlib
def fix(path, listen, port, tag):
    p = pathlib.Path(path)
    if not p.exists():
        raise SystemExit(f"missing {path}")
    d = json.loads(p.read_text())
    changed = False
    for ib in d.get("inbounds", []):
        if ib.get("protocol") != "vless":
            continue
        ib["listen"] = listen
        ib["port"] = int(port)
        s = ib.setdefault("streamSettings", {})
        s["network"] = "ws"
        s["security"] = s.get("security") or "none"
        ws = s.setdefault("wsSettings", {})
        old = ws.get("path")
        ws["path"] = "/"
        # drop xhttp if present for this inbound
        s.pop("xhttpSettings", None)
        print(f"{tag}: {old!r} -> '/' listen={listen}:{port}")
        changed = True
    if not changed:
        raise SystemExit(f"no vless inbound in {path}")
    p.write_text(json.dumps(d, indent=2) + "\n")
fix("${TE_DIR}/config.json", "${TE_LISTEN}", ${TE_PORT}, "TE")
fix("${ALI_DIR}/config.json", "${ALI_LISTEN}", ${ALI_PORT}, "ALI")
PY

# validate + restart
for dir in "$TE_DIR" "$ALI_DIR"; do
  if [ -x "$dir/xray" ]; then
    "$dir/xray" run -test -config "$dir/config.json" || /usr/local/bin/xray run -test -config "$dir/config.json"
  else
    /usr/local/bin/xray run -test -config "$dir/config.json" || xray run -test -config "$dir/config.json"
  fi
done

systemctl restart "$TE_UNIT" "$ALI_UNIT"
sleep 2
systemctl is-active "$TE_UNIT" "$ALI_UNIT"
ss -tlnp | grep -E ":${TE_PORT}|:${ALI_PORT}" || true

# stop bunny/cf xray if present (do not delete configs)
for u in \
  xray-cloudflare-ws \
  xray-fr1-bunny-xhttp2-pilot \
  xray-fr1-bunny-xhttp \
  xray-fr1-bunny-v2 \
  xray-dayanch-bunny-xhttp \
  xray-fr2-bunny-ws \
  xray-tampa-bunny-ws \
  xray-fornex-bunny-ws \
  xray-traffic-fr1-bunny-xhttp2 \
  xray-traffic-fr1-cloudflare-ws \
  xray-traffic-fr2-bunny-ws \
  xray-traffic-fr2-cloudflare-ws \
  xray-traffic-fr2-dayanch-bunny-xhttp \
  xray-traffic-fornex-cloudflare-ws \
  xray-traffic-fornex-dayanch-bunny-xhttp \
  xray-traffic-tampa-bunny-ws \
  xray-traffic-tampa-cloudflare-ws \
  xray-traffic-tampa-dayanch-bunny-xhttp \
  vpn-standalone-sync-bunny-xhttp-fr1 \
  vpn-standalone-sync-bunny-xhttp-fr2 \
  vpn-standalone-sync-bunny-xhttp-fornex \
  vpn-standalone-sync-bunny-xhttp-tampa \
  levospeed-fr1-bunny-cutover \
  dayanch-bunny-xhttp-hub-redirect
do
  systemctl stop "$u" 2>/dev/null || true
  systemctl disable "$u" 2>/dev/null || true
done
echo "DONE $ROLE"
