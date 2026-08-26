#!/bin/bash
set -euo pipefail

DIR=/opt/vpn-tampa-reality
CONFIG="$DIR/config.json"
UNIT_FILE=/etc/systemd/system/xray-tampa-reality.service
CADDYFILE=/etc/caddy/Caddyfile
CONFIG_BACKUP="$CONFIG.pre-standard-443"
UNIT_BACKUP="$UNIT_FILE.pre-standard-443"
CADDY_BACKUP="$CADDYFILE.pre-standard-443"
TMP_CONFIG=/tmp/tampa-reality-443.json
TMP_UNIT=/tmp/xray-tampa-reality-443.service
TMP_CADDY=/tmp/Caddyfile-tampa-reality-443
IMAGE=glb-vps-edge-vpn-glb-edge:latest
COMMITTED=0

PROD_CONTAINER_BEFORE="$(docker inspect -f '{{.Id}}' glb-vps-edge-vpn-glb-edge-1)"
curl --noproxy '*' -fsS --max-time 20 https://levospeed.it.com/health >/dev/null
cp "$CONFIG" "$CONFIG_BACKUP"
cp "$UNIT_FILE" "$UNIT_BACKUP"
cp "$CADDYFILE" "$CADDY_BACKUP"

rollback() {
  if [ "$COMMITTED" -eq 0 ]; then
    systemctl stop xray-tampa-reality caddy 2>/dev/null || true
    cp "$CONFIG_BACKUP" "$CONFIG"
    cp "$UNIT_BACKUP" "$UNIT_FILE"
    cp "$CADDY_BACKUP" "$CADDYFILE"
    systemctl daemon-reload
    systemctl start caddy || true
    systemctl restart xray-tampa-reality || true
  fi
}
trap rollback EXIT

python3 - "$CADDYFILE" "$TMP_CADDY" <<'PY'
from pathlib import Path
import sys

source, output = map(Path, sys.argv[1:])
text = source.read_text()
old = "levospeed.it.com, www.levospeed.it.com {\n"
new = (
    "https://levospeed.it.com:9444, https://www.levospeed.it.com:9444 {\n"
    "    bind 172.17.0.1\n"
)
if old not in text:
    raise SystemExit("Expected Tampa Caddy site label not found")
output.write_text(text.replace(old, new, 1))
PY
caddy validate --config "$TMP_CADDY"

python3 - "$CONFIG" "$TMP_CONFIG" <<'PY'
import copy
import json
import sys

source, output = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    config = json.load(handle)

legacy = next(
    (item for item in config.get("inbounds", []) if int(item.get("port", 0)) == 9443),
    None,
)
if not legacy:
    raise SystemExit("Tampa legacy REALITY inbound on 9443 not found")

standard = copy.deepcopy(legacy)
standard["port"] = 443
standard["tag"] = "vless-reality-443"
reality = standard["streamSettings"]["realitySettings"]
reality["target"] = "172.17.0.1:9444"
reality["serverNames"] = ["levospeed.it.com", "www.levospeed.it.com"]
reality.pop("dest", None)

existing = next(
    (item for item in config.get("inbounds", []) if int(item.get("port", 0)) == 443),
    None,
)
if existing:
    config["inbounds"][config["inbounds"].index(existing)] = standard
else:
    config["inbounds"].insert(1, standard)

with open(output, "w", encoding="utf-8") as handle:
    json.dump(config, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

docker run --rm \
  -v "$TMP_CONFIG:/etc/xray/config.json:ro" \
  --entrypoint xray "$IMAGE" run -test -c /etc/xray/config.json

python3 - "$UNIT_FILE" "$TMP_UNIT" <<'PY'
from pathlib import Path
import sys

source, output = map(Path, sys.argv[1:])
text = source.read_text()
old = "-p 0.0.0.0:9443:9443/tcp"
new = "-p 0.0.0.0:443:443/tcp -p 0.0.0.0:9443:9443/tcp"
if new not in text:
    if old not in text:
        raise SystemExit("Expected Tampa Docker mapping not found")
    text = text.replace(old, new, 1)
output.write_text(text)
PY

docker rm -f xray-tampa-fallback-test >/dev/null 2>&1 || true
iptables -C INPUT -i docker0 -p tcp -d 172.17.0.1 --dport 9444 -j ACCEPT 2>/dev/null ||
  iptables -I INPUT -i docker0 -p tcp -d 172.17.0.1 --dport 9444 -j ACCEPT
if command -v ufw >/dev/null 2>&1; then
  ufw allow in on docker0 to 172.17.0.1 port 9444 proto tcp >/dev/null
fi
systemctl stop xray-tampa-reality caddy
install -m 644 "$TMP_CADDY" "$CADDYFILE"
systemctl start caddy
sleep 2
systemctl is-active --quiet caddy
ss -ltn | awk '$4 ~ /172\.17\.0\.1:9444$/ {found=1} END {exit !found}'
curl --noproxy '*' -kfsS --max-time 20 \
  --resolve levospeed.it.com:9444:172.17.0.1 \
  https://levospeed.it.com:9444/health >/dev/null

install -m 600 "$TMP_CONFIG" "$CONFIG"
install -m 644 "$TMP_UNIT" "$UNIT_FILE"
systemctl daemon-reload
systemctl restart xray-tampa-reality
sleep 3
systemctl is-active --quiet xray-tampa-reality
systemctl is-active --quiet moonlight-proxy
for port in 443 9443; do
  ss -ltn | awk -v port=":$port" '$4 ~ port"$" {found=1} END {exit !found}'
done
curl --noproxy '*' -fsS --max-time 20 https://levospeed.it.com/health >/dev/null

PROD_CONTAINER_AFTER="$(docker inspect -f '{{.Id}}' glb-vps-edge-vpn-glb-edge-1)"
[ "$PROD_CONTAINER_AFTER" = "$PROD_CONTAINER_BEFORE" ] || {
  echo "Tampa production relay container changed unexpectedly" >&2
  exit 1
}

COMMITTED=1
trap - EXIT
rm -f "$TMP_CONFIG" "$TMP_UNIT" "$TMP_CADDY" /tmp/tampa-reality-fallback-test.json
echo "TAMPA_REALITY_STANDARD_443_OK"
echo "production_container=$PROD_CONTAINER_AFTER"
