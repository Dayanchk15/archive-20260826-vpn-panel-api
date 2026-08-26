#!/bin/sh
set -u
docker ps --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Ports}}'
echo COMPOSE
if [ -f /opt/vpn-relay-edge/docker-compose.edge.yml ]; then
  sed -n '1,280p' /opt/vpn-relay-edge/docker-compose.edge.yml
elif [ -f /opt/vpn-relay-edge/docker-compose.yml ]; then
  sed -n '1,280p' /opt/vpn-relay-edge/docker-compose.yml
fi
echo INSPECT
docker ps -q | while read -r container; do
  docker inspect "$container" | python3 -c '
import json, sys
x=json.load(sys.stdin)[0]
env={}
for item in x.get("Config",{}).get("Env",[]):
    key, _, value=item.partition("=")
    if any(word in key.upper() for word in ("KEY","TOKEN","PASSWORD","SECRET")):
        value="<redacted>"
    env[key]=value
print(json.dumps({"name":x.get("Name"),"network":x.get("HostConfig",{}).get("NetworkMode"),"env":env},separators=(",",":")))
'
done
