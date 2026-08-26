#!/bin/sh
set -eu

RULE="-p tcp --dport 18092 -m conntrack --ctstate NEW -j REDIRECT --to-ports 18096"
if ! /usr/sbin/iptables -t nat -C PREROUTING $RULE 2>/dev/null; then
  /usr/sbin/iptables -t nat -I PREROUTING 1 $RULE
fi
