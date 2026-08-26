#!/usr/bin/env bash
set -euo pipefail
NAME=vpn-panel-api-vps
PUBLIC_SRC=/opt/vpn-panel-api-vps/public

if [[ ! -f "$PUBLIC_SRC/admin.html" ]]; then
  echo "Missing $PUBLIC_SRC/admin.html" >&2
  exit 1
fi

IMAGE="$(docker inspect -f '{{.Config.Image}}' "$NAME")"
NETWORK="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$NAME")"
PORT_MAP="$(docker inspect -f '{{range $p, $conf := .NetworkSettings.Ports}}{{if $conf}}{{(index $conf 0).HostIp}}:{{(index $conf 0).HostPort}}:{{$p}}{{end}}{{end}}' "$NAME")"

ENV_ARGS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && ENV_ARGS+=(-e "$line")
done < <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME")

BIND_ARGS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && BIND_ARGS+=(-v "$line")
done < <(docker inspect -f '{{range .HostConfig.Binds}}{{println .}}{{end}}' "$NAME")

if ! printf '%s\n' "${BIND_ARGS[@]}" | grep -q '/app/public'; then
  BIND_ARGS+=(-v "$PUBLIC_SRC:/app/public:ro")
fi

echo "Recreating $NAME with public mount..."
docker stop "$NAME"
docker rm "$NAME"

RUN_ARGS=(docker run -d --name "$NAME" --restart unless-stopped)
[[ -n "$NETWORK" ]] && RUN_ARGS+=(--network "$NETWORK")
[[ -n "$PORT_MAP" ]] && RUN_ARGS+=(-p "$PORT_MAP")
RUN_ARGS+=("${ENV_ARGS[@]}" "${BIND_ARGS[@]}" "$IMAGE")

"${RUN_ARGS[@]}"
sleep 6
docker exec "$NAME" grep -c 'dealerResetAllUsage' /app/public/admin.html
docker ps --filter "name=$NAME" --format '{{.Status}}'
