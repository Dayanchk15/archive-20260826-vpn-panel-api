FROM node:20-slim

WORKDIR /app

COPY vpn-edge-sync-agent/package.json ./vpn-edge-sync-agent/
COPY vpn-edge/proto ./vpn-edge/proto
COPY vpn-edge/xray-client-diff.js ./vpn-edge/
COPY vpn-edge-sync-agent/server.mjs ./vpn-edge-sync-agent/

RUN cd vpn-edge-sync-agent && npm install --omit=dev

RUN ln -sf /app/vpn-edge-sync-agent/node_modules /app/node_modules

ENV AGENT_PORT=19222
ENV EDGE_ENV_FILE=/opt/vpn-relay-edge/.env
ENV XRAY_BIN=/usr/local/bin/xray
ENV EDGE_SYNC_ALLOW_RESTART=false

EXPOSE 19222

CMD ["node", "vpn-edge-sync-agent/server.mjs"]
