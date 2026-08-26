#!/usr/bin/env bash
set -euo pipefail
KEY="${KEY:-$HOME/.ssh/id_ed25519}"
WIN_KEY="C:/Users/Admin/.ssh/id_ed25519"
if [[ -f "$WIN_KEY" ]]; then KEY="$WIN_KEY"; fi
JUMP="root@194.127.179.178"
SSH_BASE=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -i "$KEY")
SCP_BASE=(scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -i "$KEY")

ssh_edge() {
  local jump="$1" host="$2"; shift 2
  if [[ "$jump" == "1" ]]; then
    "${SSH_BASE[@]}" -o "ProxyCommand=ssh -o BatchMode=yes -i $KEY -W %h:%p $JUMP" "root@$host" "$@"
  else
    "${SSH_BASE[@]}" "root@$host" "$@"
  fi
}

scp_edge() {
  local jump="$1" host="$2" src="$3" dst="$4"
  if [[ "$jump" == "1" ]]; then
    "${SCP_BASE[@]}" -o "ProxyCommand=ssh -o BatchMode=yes -i $KEY -W %h:%p $JUMP" "$src" "root@$host:$dst"
  else
    "${SCP_BASE[@]}" "$src" "root@$host:$dst"
  fi
}

gen_config() {
  local port="$1" out="$2"
  ssh -J "$JUMP" -o BatchMode=yes root@45.140.42.39 \
    "docker exec vpn-panel-api-vps env EDGE_TCP_PORT=$port OUTPUT=/data/files/$out node /data/files/generate-edge-config-file.mjs"
}

apply_bare() {
  local jump="$1" host="$2" port="$3" cfg="$4"
  scp_edge "$jump" "$host" "/tmp/$cfg" "/opt/vpn-relay-edge/config.json"
  ssh_edge "$jump" "$host" "set -euo pipefail
/usr/local/bin/xray run -test -config /opt/vpn-relay-edge/config.json
pkill -f 'xray run' 2>/dev/null || true
sleep 1
nohup /usr/local/bin/xray run -c /opt/vpn-relay-edge/config.json >/var/log/vpn-relay-edge.log 2>&1 &
sleep 2
ss -tlnp | grep ':${port}\\b'
echo OK_BARE ${host}:${port}"
}

apply_docker() {
  local jump="$1" host="$2" ext_port="$3" cfg="$4"
  scp_edge "$jump" "$host" "/tmp/$cfg" "/opt/vpn-relay-edge/config.json"
  ssh_edge "$jump" "$host" "set -euo pipefail
cd /opt/vpn-relay-edge
COMPOSE=\$(ls docker-compose*.yml 2>/dev/null | head -1)
if grep -q XRAY_EDGE_MODE \"\$COMPOSE\"; then
  sed -i 's/XRAY_EDGE_MODE:.*/XRAY_EDGE_MODE: tcp/' \"\$COMPOSE\"
else
  sed -i '/environment:/a\\      XRAY_EDGE_MODE: tcp' \"\$COMPOSE\"
fi
docker compose -f \"\$COMPOSE\" up -d --force-recreate
sleep 8
C=\$(docker ps --format '{{.Names}}' | grep vpn-relay-edge | head -1)
docker exec \"\$C\" ss -tlnp | grep ':8080\\b'
ss -tlnp | grep ':${ext_port}\\b' || true
echo OK_DOCKER ${host}:${ext_port}"
}

TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$TMPDIR"

echo "=== Generating configs on panel ==="
gen_config 8080 edge-tcp-docker.json
gen_config 8082 edge-tcp-8082.json
gen_config 8088 edge-tcp-8088.json
gen_config 8089 edge-tcp-8089.json
gen_config 8080 edge-tcp-usa.json

scp -J "$JUMP" -o BatchMode=yes root@45.140.42.39:/opt/vpn-panel/files/edge-tcp-docker.json "$TMPDIR/"
scp -J "$JUMP" -o BatchMode=yes root@45.140.42.39:/opt/vpn-panel/files/edge-tcp-8082.json "$TMPDIR/"
scp -J "$JUMP" -o BatchMode=yes root@45.140.42.39:/opt/vpn-panel/files/edge-tcp-8088.json "$TMPDIR/"
scp -J "$JUMP" -o BatchMode=yes root@45.140.42.39:/opt/vpn-panel/files/edge-tcp-8089.json "$TMPDIR/"
scp -J "$JUMP" -o BatchMode=yes root@45.140.42.39:/opt/vpn-panel/files/edge-tcp-usa.json "$TMPDIR/"

cp "$TMPDIR/edge-tcp-docker.json" "$TMPDIR/edge-tcp-docker.json.bak"

echo "=== NL docker 8081 ==="
apply_docker 1 194.127.178.70 8081 "$TMPDIR/edge-tcp-docker.json"

echo "=== AM docker 8083 ==="
apply_docker 0 194.127.179.178 8083 "$TMPDIR/edge-tcp-docker.json"

echo "=== GB docker 8084 ==="
apply_docker 1 185.169.234.182 8084 "$TMPDIR/edge-tcp-docker.json"

echo "=== DE2 docker 8085 ==="
apply_docker 0 45.133.251.146 8085 "$TMPDIR/edge-tcp-docker.json"

echo "=== DE bare 8082 ==="
apply_bare 1 2.26.231.130 8082 "$TMPDIR/edge-tcp-8082.json" || echo "DE_FAILED"

echo "=== FR1 bare 8088 ==="
apply_bare 0 185.209.230.14 8088 "$TMPDIR/edge-tcp-8088.json"

echo "=== FR2 bare 8089 ==="
apply_bare 0 185.209.230.46 8089 "$TMPDIR/edge-tcp-8089.json"

echo "=== USA bare 8080 ==="
apply_bare 0 74.115.172.101 8080 "$TMPDIR/edge-tcp-usa.json"

echo "=== ALL VPS TCP DONE ==="
