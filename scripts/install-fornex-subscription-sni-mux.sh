#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="/etc/haproxy/certs"
XRAY_PORT="443"
MUX_PORT="4443"
SUBSCRIPTION_PORT="8443"
PANEL_HOST="sub.twidu.com"
PANEL_IP="45.140.42.39"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

for cert in levospeed.pem www.levospeed.pem; do
  if [[ ! -s "${CERT_DIR}/${cert}" ]]; then
    echo "Missing ${CERT_DIR}/${cert}" >&2
    exit 1
  fi
done

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq haproxy

install -d -m 0700 /etc/haproxy/backups
if [[ -f /etc/haproxy/haproxy.cfg ]]; then
  cp -a /etc/haproxy/haproxy.cfg "/etc/haproxy/backups/haproxy.cfg.$(date -u +%Y%m%dT%H%M%SZ)"
fi

cat >/etc/haproxy/haproxy.cfg <<EOF
global
  log /dev/log local0
  log /dev/log local1 notice
  user haproxy
  group haproxy
  daemon
  maxconn 20000

defaults
  log global
  mode tcp
  option dontlognull
  timeout connect 10s
  timeout client 1h
  timeout server 1h
  timeout tunnel 1h

frontend tls_mux
  bind 0.0.0.0:${MUX_PORT}
  mode tcp
  tcp-request inspect-delay 5s
  tcp-request content accept if { req.ssl_hello_type 1 }
  acl subscription_sni req.ssl_sni -i levospeed.it.com www.levospeed.it.com
  use_backend subscription_tls if subscription_sni
  default_backend xray_reality

backend subscription_tls
  mode tcp
  server local_subscription 127.0.0.1:${SUBSCRIPTION_PORT}

backend xray_reality
  mode tcp
  server existing_xray 127.0.0.1:${XRAY_PORT}

frontend subscription_https
  bind 127.0.0.1:${SUBSCRIPTION_PORT} ssl crt ${CERT_DIR}/ alpn h2,http/1.1
  mode http
  option httplog
  http-request set-header Host ${PANEL_HOST}
  http-request set-header X-Forwarded-Proto https
  http-response del-header Alt-Svc
  default_backend panel_https

backend panel_https
  mode http
  server panel ${PANEL_IP}:443 ssl verify required ca-file /etc/ssl/certs/ca-certificates.crt sni str(${PANEL_HOST}) check check-sni ${PANEL_HOST}
EOF

haproxy -c -f /etc/haproxy/haproxy.cfg
systemctl enable haproxy
systemctl restart haproxy

cat >/etc/systemd/system/fornex-tls-mux-nat.service <<EOF
[Unit]
Description=Route new TCP/443 connections through the Fornex TLS SNI mux
After=network-online.target haproxy.service
Wants=network-online.target
Requires=haproxy.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c '/usr/sbin/iptables -t nat -C PREROUTING -p tcp --dport ${XRAY_PORT} -j REDIRECT --to-ports ${MUX_PORT} 2>/dev/null || /usr/sbin/iptables -t nat -I PREROUTING 1 -p tcp --dport ${XRAY_PORT} -j REDIRECT --to-ports ${MUX_PORT}'
ExecStop=/bin/sh -c '/usr/sbin/iptables -t nat -C PREROUTING -p tcp --dport ${XRAY_PORT} -j REDIRECT --to-ports ${MUX_PORT} 2>/dev/null && /usr/sbin/iptables -t nat -D PREROUTING -p tcp --dport ${XRAY_PORT} -j REDIRECT --to-ports ${MUX_PORT} || true'

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
if command -v ufw >/dev/null 2>&1; then
  ufw allow "${MUX_PORT}/tcp" >/dev/null
fi
systemctl enable --now fornex-tls-mux-nat.service

haproxy -c -f /etc/haproxy/haproxy.cfg
systemctl is-active --quiet haproxy
systemctl is-active --quiet fornex-tls-mux-nat.service
echo "Fornex TLS SNI mux installed"
