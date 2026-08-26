#!/bin/bash
# Remove retired Xray instances while preserving relay-v2 and Bunny pilots.
set -euo pipefail

TARGET="${1:?target is required: fr1|fr2|tampa}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/root/xray-prune-${TARGET}-${STAMP}.tar.gz"

active() { systemctl is-active --quiet "$1"; }
disable_remove_unit() {
  local unit="$1"
  systemctl disable --now "$unit" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$unit" "/lib/systemd/system/$unit"
}
stop_pid_by_config_if_idle() {
  local config="$1"
  local pids
  pids="$(pgrep -f "xray.*${config}" || true)"
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    local established
    established="$(ss -Htnp state established 2>/dev/null | awk -v needle="pid=$pid," 'index($0, needle) { count++ } END { print count + 0 }')"
    [ "$established" = "0" ] || {
      echo "Refusing to stop PID $pid ($config): $established established connections" >&2
      exit 1
    }
    kill "$pid"
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "PID $pid did not stop cleanly" >&2
      exit 1
    fi
  done
}

case "$TARGET" in
  fr1)
    active xray-relay-v2.service
    active xray-fr1-bunny-xhttp.service
    tar -czf "$BACKUP" --ignore-failed-read \
      /opt/vpn-relay-edge /opt/vpn-fr1-tcp-pilot \
      /etc/systemd/system/xray-fr1-tcp-pilot.service \
      /etc/systemd/system/vpn-standalone-sync-pilot-fr1-tcp.service \
      /etc/systemd/system/vpn-fr1-tcp-ws-bridge.service 2>/dev/null || true
    chmod 600 "$BACKUP"

    disable_remove_unit xray-fr1-tcp-pilot.service
    disable_remove_unit vpn-standalone-sync-pilot-fr1-tcp.service
    disable_remove_unit vpn-fr1-tcp-ws-bridge.service
    stop_pid_by_config_if_idle /opt/vpn-relay-edge/config.json
    rm -rf /opt/vpn-relay-edge /opt/vpn-fr1-tcp-pilot
    ;;

  fr2)
    active xray-relay-v2.service
    active xray-fr2-bunny-ws.service
    for log in /var/log/vpn-fr2-fastly-access.log /var/log/vpn-fr2-fastly-v2-access.log; do
      if [ -f "$log" ] && find "$log" -mmin -30 -print -quit | grep -q .; then
        echo "Refusing FR2 cleanup: recent Fastly activity in $log" >&2
        exit 1
      fi
    done
    tar -czf "$BACKUP" --ignore-failed-read \
      /opt/vpn-relay-edge /opt/vpn-fr2-tcp-pilot \
      /opt/vpn-fr2-fastly /opt/vpn-fr2-fastly-v2 \
      /etc/systemd/system/xray-fr2-tcp-pilot.service \
      /etc/systemd/system/xray-fr2-fastly.service \
      /etc/systemd/system/xray-fr2-fastly-v2.service 2>/dev/null || true
    chmod 600 "$BACKUP"

    disable_remove_unit xray-fr2-tcp-pilot.service
    disable_remove_unit xray-fr2-fastly.service
    disable_remove_unit xray-fr2-fastly-v2.service
    disable_remove_unit vpn-standalone-sync-pilot-fr2-tcp.service
    disable_remove_unit vpn-standalone-sync-pilot-fr2-xhttp.service
    disable_remove_unit xray-traffic-fr2-pilot.service
    disable_remove_unit fr2-fastly-port80-redirect.service
    stop_pid_by_config_if_idle /opt/vpn-relay-edge/config.json
    rm -rf /opt/vpn-relay-edge /opt/vpn-fr2-tcp-pilot \
      /opt/vpn-fr2-fastly /opt/vpn-fr2-fastly-v2
    rm -f /usr/local/bin/xray-26.3.27
    ;;

  tampa)
    active xray-relay-v2.service
    tar -czf "$BACKUP" --ignore-failed-read \
      /opt/glb-vps-edge /opt/vpn-tampa-reality /opt/vpn-tampa-fastly-xhttp \
      /etc/systemd/system/xray-tampa-reality.service 2>/dev/null || true
    chmod 600 "$BACKUP"

    disable_remove_unit xray-tampa-reality.service
    disable_remove_unit xray-traffic-tampa-reality.service
    for container in \
      xray-tampa-fastly-xhttp \
      vpn-tampa-fastly-xhttp-sync-agent \
      vpn-tampa-reality-sync-agent \
      glb-vps-edge-vpn-glb-edge-1; do
      docker update --restart=no "$container" >/dev/null 2>&1 || true
      docker stop -t 20 "$container" >/dev/null 2>&1 || true
      docker rm "$container" >/dev/null 2>&1 || true
    done
    rm -rf /opt/glb-vps-edge /opt/vpn-tampa-reality /opt/vpn-tampa-fastly-xhttp
    ;;

  *)
    echo "Unknown target: $TARGET" >&2
    exit 2
    ;;
esac

systemctl daemon-reload
active xray-relay-v2.service
case "$TARGET" in
  fr1) active xray-fr1-bunny-xhttp.service ;;
  fr2) active xray-fr2-bunny-ws.service ;;
esac

count="$(pgrep -f '/(xray|xray-relay-v2)( |$)' 2>/dev/null | wc -l || true)"
echo "XRAY_PRUNE_OK target=$TARGET backup=$BACKUP count=$count"
