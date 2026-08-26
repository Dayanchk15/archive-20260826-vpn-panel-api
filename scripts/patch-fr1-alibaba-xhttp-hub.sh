#!/bin/bash
# Add Alibaba ESA xHTTP routes to the existing FR1 public origin hub (:18108).
# Safe/idempotent: backs up the Caddy snippet, inserts only once, validates, reloads.
set -euo pipefail

CADDY_SNIPPET="${CADDY_SNIPPET:-/etc/caddy/conf.d/fr1-tencent-edgeone-hub.caddy}"
MARK_BEGIN="# ALIBABA_ESA_XHTTP_HUB_BEGIN"
MARK_END="# ALIBABA_ESA_XHTTP_HUB_END"

[ -f "$CADDY_SNIPPET" ]

if grep -qF "$MARK_BEGIN" "$CADDY_SNIPPET"; then
  echo "ALIBABA_XHTTP_HUB_ALREADY_PRESENT file=$CADDY_SNIPPET"
  caddy validate --config /etc/caddy/Caddyfile >/tmp/caddy-alibaba-xhttp-validate.log 2>&1
  systemctl reload caddy
  exit 0
fi

BACKUP="${CADDY_SNIPPET}.pre-alibaba-xhttp-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$CADDY_SNIPPET" "$BACKUP"

python3 - "$CADDY_SNIPPET" "$MARK_BEGIN" "$MARK_END" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
mark_begin = sys.argv[2]
mark_end = sys.argv[3]
text = path.read_text()
if mark_begin in text:
    raise SystemExit(0)

block = f'''

\t{mark_begin}
\t@ali_xhttp_fr1 path /media/v4/fr1/sync*
\thandle @ali_xhttp_fr1 {{
\t\treverse_proxy h2c://127.0.0.1:18097 {{
\t\t\theader_up Host levospeedfr1xhttp2.b-cdn.net
\t\t\tflush_interval -1
\t\t}}
\t}}

\t@ali_xhttp_fr2 path /media/v4/fr2/sync*
\thandle @ali_xhttp_fr2 {{
\t\treverse_proxy h2c://127.0.0.1:18101 {{
\t\t\tflush_interval -1
\t\t}}
\t}}

\t@ali_xhttp_fornex path /media/v4/fornex/sync*
\thandle @ali_xhttp_fornex {{
\t\treverse_proxy h2c://127.0.0.1:18102 {{
\t\t\tflush_interval -1
\t\t}}
\t}}

\t@ali_xhttp_tampa path /media/v4/tampa/sync*
\thandle @ali_xhttp_tampa {{
\t\treverse_proxy h2c://127.0.0.1:18103 {{
\t\t\tflush_interval -1
\t\t}}
\t}}
\t{mark_end}
'''

needle = "\n\trespond 404\n"
if needle not in text:
    raise SystemExit("Cannot find final respond 404 insertion point")
path.write_text(text.replace(needle, block + needle, 1))
PY

caddy validate --config /etc/caddy/Caddyfile >/tmp/caddy-alibaba-xhttp-validate.log 2>&1 || {
  cp -a "$BACKUP" "$CADDY_SNIPPET"
  echo "Caddy validate failed; restored $BACKUP" >&2
  cat /tmp/caddy-alibaba-xhttp-validate.log >&2
  exit 1
}

systemctl reload caddy

echo "ALIBABA_XHTTP_HUB_OK file=$CADDY_SNIPPET backup=$BACKUP"
