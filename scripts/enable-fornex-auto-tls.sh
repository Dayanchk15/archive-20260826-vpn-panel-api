#!/usr/bin/env bash
set -euo pipefail

CADDY_BIN=/usr/local/bin/caddy
CADDY_CONFIG=/etc/caddy/Caddyfile
HAPROXY_CONFIG=/etc/haproxy/haproxy.cfg
XRAY_PID_BEFORE="$(systemctl show -p MainPID --value xray-fornex-test.service)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi
if [[ ! -x "${CADDY_BIN}" ]]; then
  echo "Missing ${CADDY_BIN}" >&2
  exit 1
fi

getent group caddy >/dev/null || groupadd --system caddy
id caddy >/dev/null 2>&1 || useradd --system --gid caddy --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
install -d -o root -g root -m 0755 /etc/caddy
install -d -o caddy -g caddy -m 0750 /var/lib/caddy /var/log/caddy

cat >"${CADDY_CONFIG}" <<'EOF'
{
  admin 127.0.0.1:2019
  http_port 8081
  https_port 8444
  servers {
    protocols h1 h2
  }
}

levospeed.it.com, www.levospeed.it.com {
  bind 127.0.0.1
  tls {
    issuer acme {
      disable_http_challenge
    }
  }
  reverse_proxy https://45.140.42.39 {
    header_up Host sub.twidu.com
    header_down -Alt-Svc
    transport http {
      tls_server_name sub.twidu.com
    }
  }
}
EOF

"${CADDY_BIN}" validate --config "${CADDY_CONFIG}" --adapter caddyfile

cat >/etc/systemd/system/caddy-levospeed.service <<EOF
[Unit]
Description=Caddy automatic TLS for levospeed.it.com on the Fornex SNI mux
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
Environment=HOME=/var/lib/caddy
ExecStart=${CADDY_BIN} run --environ --config ${CADDY_CONFIG} --adapter caddyfile
ExecReload=${CADDY_BIN} reload --config ${CADDY_CONFIG} --adapter caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/caddy /var/log/caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=on-failure
RestartSec=2s

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now caddy-levospeed.service

# Stage 1: keep the current HAProxy TLS termination for users, but send only
# ACME TLS-ALPN validation handshakes to Caddy on 8444.
cat >"${HAPROXY_CONFIG}" <<'EOF'
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
  bind 0.0.0.0:4443
  mode tcp
  tcp-request inspect-delay 5s
  tcp-request content accept if { req.ssl_hello_type 1 }
  acl subscription_sni req.ssl_sni -i levospeed.it.com www.levospeed.it.com
  acl acme_tls_alpn req.ssl_alpn -m sub acme-tls/1
  use_backend subscription_caddy if subscription_sni acme_tls_alpn
  use_backend subscription_legacy_tls if subscription_sni
  default_backend xray_reality

backend subscription_caddy
  mode tcp
  server caddy 127.0.0.1:8444

backend subscription_legacy_tls
  mode tcp
  server local_subscription 127.0.0.1:8443

backend xray_reality
  mode tcp
  server existing_xray 127.0.0.1:443

frontend subscription_https
  bind 127.0.0.1:8443 ssl crt /etc/haproxy/certs/ alpn h2,http/1.1
  mode http
  option httplog
  http-request set-header Host sub.twidu.com
  http-request set-header X-Forwarded-Proto https
  http-response del-header Alt-Svc
  default_backend panel_https

backend panel_https
  mode http
  server panel 45.140.42.39:443 ssl verify required ca-file /etc/ssl/certs/ca-certificates.crt sni str(sub.twidu.com) check check-sni sub.twidu.com
EOF

haproxy -c -f "${HAPROXY_CONFIG}"
systemctl reload haproxy
systemctl restart caddy-levospeed.service

deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  if echo | openssl s_client -connect 127.0.0.1:8444 -servername levospeed.it.com 2>/dev/null \
      | openssl x509 -noout -subject -issuer 2>/dev/null \
      | grep -q 'CN = levospeed.it.com'; then
    break
  fi
  sleep 3
done

if ! echo | openssl s_client -connect 127.0.0.1:8444 -servername levospeed.it.com 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | grep -q 'CN = levospeed.it.com'; then
  journalctl -u caddy-levospeed.service -n 80 --no-pager >&2
  echo "Caddy did not obtain the levospeed.it.com certificate; legacy TLS remains active" >&2
  exit 1
fi

if ! echo | openssl s_client -connect 127.0.0.1:8444 -servername www.levospeed.it.com 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | grep -q 'CN = www.levospeed.it.com'; then
  journalctl -u caddy-levospeed.service -n 80 --no-pager >&2
  echo "Caddy did not obtain the www.levospeed.it.com certificate; legacy TLS remains active" >&2
  exit 1
fi

# Stage 2: Caddy now owns normal subscription TLS and future renewals.
cat >"${HAPROXY_CONFIG}" <<'EOF'
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
  bind 0.0.0.0:4443
  mode tcp
  tcp-request inspect-delay 5s
  tcp-request content accept if { req.ssl_hello_type 1 }
  acl subscription_sni req.ssl_sni -i levospeed.it.com www.levospeed.it.com
  use_backend subscription_caddy if subscription_sni
  default_backend xray_reality

backend subscription_caddy
  mode tcp
  server caddy 127.0.0.1:8444

backend xray_reality
  mode tcp
  server existing_xray 127.0.0.1:443
EOF

haproxy -c -f "${HAPROXY_CONFIG}"
systemctl reload haproxy

XRAY_PID_AFTER="$(systemctl show -p MainPID --value xray-fornex-test.service)"
if [[ -z "${XRAY_PID_BEFORE}" || "${XRAY_PID_BEFORE}" != "${XRAY_PID_AFTER}" ]]; then
  echo "Xray PID changed unexpectedly: ${XRAY_PID_BEFORE} -> ${XRAY_PID_AFTER}" >&2
  exit 1
fi

systemctl is-active --quiet caddy-levospeed.service
systemctl is-active --quiet haproxy
systemctl is-active --quiet fornex-tls-mux-nat.service
echo "FORNEX_AUTO_TLS_OK xray_pid=${XRAY_PID_AFTER}"
