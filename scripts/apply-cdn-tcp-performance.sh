#!/bin/bash
# Apply the conservative CDN origin TCP profile without restarting Xray.
set -euo pipefail

PERFORMANCE_CONFIG="${PERFORMANCE_CONFIG:-/tmp/99-vpn-bunny-performance.conf}"
MODULE_CONFIG="${MODULE_CONFIG:-/tmp/tcp_bbr.conf}"
XRAY_UNITS="${XRAY_UNITS:-xray-cloudflare-ws.service xray-fr1-bunny-v2.service}"
TARGET_PERFORMANCE_CONFIG=/etc/sysctl.d/99-vpn-bunny-performance.conf
TARGET_MODULE_CONFIG=/etc/modules-load.d/tcp_bbr.conf

[ -r "$PERFORMANCE_CONFIG" ] || { echo "missing performance config: $PERFORMANCE_CONFIG" >&2; exit 1; }
[ -r "$MODULE_CONFIG" ] || { echo "missing module config: $MODULE_CONFIG" >&2; exit 1; }
modinfo tcp_bbr >/dev/null

declare -A before_pids
for unit in $XRAY_UNITS; do
  systemctl is-active --quiet "$unit"
  before_pids["$unit"]="$(systemctl show -p MainPID --value "$unit")"
  [ "${before_pids[$unit]}" != "0" ]
done

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [ -e "$TARGET_PERFORMANCE_CONFIG" ]; then
  cp -a "$TARGET_PERFORMANCE_CONFIG" "${TARGET_PERFORMANCE_CONFIG}.pre-cdn-tuning.${stamp}"
fi
if [ -e "$TARGET_MODULE_CONFIG" ]; then
  cp -a "$TARGET_MODULE_CONFIG" "${TARGET_MODULE_CONFIG}.pre-cdn-tuning.${stamp}"
fi

modprobe tcp_bbr
install -m 644 "$MODULE_CONFIG" "$TARGET_MODULE_CONFIG"
install -m 644 "$PERFORMANCE_CONFIG" "$TARGET_PERFORMANCE_CONFIG"
sysctl -p "$TARGET_PERFORMANCE_CONFIG" >/dev/null

[ "$(sysctl -n net.ipv4.tcp_congestion_control)" = "bbr" ]
[ "$(sysctl -n net.core.default_qdisc)" = "fq" ]
[ "$(sysctl -n net.ipv4.tcp_mtu_probing)" = "1" ]

for unit in $XRAY_UNITS; do
  systemctl is-active --quiet "$unit"
  after_pid="$(systemctl show -p MainPID --value "$unit")"
  [ "$after_pid" = "${before_pids[$unit]}" ] || {
    echo "unexpected Xray restart: $unit ${before_pids[$unit]} -> $after_pid" >&2
    exit 1
  }
done

echo "CDN_TCP_PERFORMANCE_OK congestion=bbr qdisc=fq mtuProbing=1 xrayRestarted=false"
