#!/bin/bash
# Open relay edge ports in UFW on all VPS backends.
set -e
open_port() {
  local host=$1 port=$2 jump=$3
  local cmd="ufw allow ${port}/tcp >/dev/null 2>&1 || true; ufw status | grep ${port}/tcp || echo MISSING_${port}"
  if [ "$jump" = "jump" ]; then
    ssh -o BatchMode=yes -J root@194.127.179.178 root@"$host" "$cmd"
  else
    ssh -o BatchMode=yes root@"$host" "$cmd"
  fi
}

echo "=== NL 8081 ===" && open_port 194.127.178.70 8081 jump
echo "=== DE 8082 ===" && open_port 2.26.231.130 8082 jump
echo "=== AM 8083 ===" && open_port 194.127.179.178 8083 direct
echo "=== GB 8084 ===" && open_port 185.169.234.182 8084 jump
echo "=== DE2 8085 ===" && open_port 45.133.251.146 8085 direct
echo "=== FR1 8088 ===" && open_port 185.209.230.14 8088 direct
echo "=== FR2 8089 ===" && open_port 185.209.230.46 8089 direct
echo "=== USA 8080 ===" && open_port 74.115.172.101 8080 direct
echo DONE
