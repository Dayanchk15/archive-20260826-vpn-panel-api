#!/bin/bash
set -euo pipefail

XRAY=/usr/local/bin/xray
CONFIG=/opt/vpn-fr2-tcp-pilot/config.json
UNIT=xray-fr2-tcp-pilot
BACKUP="${CONFIG}.pre-standard-443"
TMP=/tmp/fr2-tcp-pilot-443.json
PRODUCTION_CONFIG=/opt/vpn-relay-edge/config.json
COMMITTED=0

PRODUCTION_PID_BEFORE="$(pgrep -f "^xray run -c ${PRODUCTION_CONFIG}$" || true)"
[ -n "$PRODUCTION_PID_BEFORE" ] || {
  echo "FR2 production Xray is not running" >&2
  exit 1
}
[ -s "$CONFIG" ] || { echo "FR2 pilot config is missing" >&2; exit 1; }
cp "$CONFIG" "$BACKUP"

rollback() {
  if [ "$COMMITTED" -eq 0 ]; then
    cp "$BACKUP" "$CONFIG"
    systemctl restart "$UNIT" || true
  fi
}
trap rollback EXIT

python3 - "$CONFIG" "$TMP" <<'PY'
import copy
import json
import sys

source, output = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    config = json.load(handle)

public = next(
    (item for item in config.get("inbounds", []) if int(item.get("port", 0)) == 18443),
    None,
)
if not public:
    raise SystemExit("Public FR2 pilot inbound on 18443 not found")

standard = next(
    (item for item in config.get("inbounds", []) if int(item.get("port", 0)) == 443),
    None,
)
if standard:
    replacement = copy.deepcopy(public)
    replacement["port"] = 443
    replacement["tag"] = "vless-fr2-tcp-443"
    config["inbounds"][config["inbounds"].index(standard)] = replacement
else:
    standard = copy.deepcopy(public)
    standard["port"] = 443
    standard["tag"] = "vless-fr2-tcp-443"
    config["inbounds"].insert(1, standard)

with open(output, "w", encoding="utf-8") as handle:
    json.dump(config, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

"$XRAY" run -test -config "$TMP"
install -m 600 "$TMP" "$CONFIG"
systemctl restart "$UNIT"
sleep 2
systemctl is-active --quiet "$UNIT"

if command -v ufw >/dev/null 2>&1 && ufw status | awk 'NR==1 {exit $2 != "active"}'; then
  ufw allow 443/tcp >/dev/null
fi
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null ||
  iptables -I INPUT -p tcp --dport 443 -j ACCEPT

PRODUCTION_PID_AFTER="$(pgrep -f "^xray run -c ${PRODUCTION_CONFIG}$" || true)"
[ "$PRODUCTION_PID_AFTER" = "$PRODUCTION_PID_BEFORE" ] || {
  echo "FR2 production process changed unexpectedly" >&2
  exit 1
}
for port in 443 18443 8089; do
  ss -ltn | awk -v port=":$port" '$4 ~ port"$" {found=1} END {exit !found}'
done

COMMITTED=1
trap - EXIT
rm -f "$TMP"
echo "FR2_STANDARD_443_OK"
echo "production_pid=$PRODUCTION_PID_AFTER"
