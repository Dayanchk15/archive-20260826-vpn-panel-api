FROM alpine:3.20

RUN apk add --no-cache curl unzip ca-certificates

ARG XRAY_VERSION=24.12.31

RUN mkdir -p /usr/local/bin /usr/local/etc/xray && \
    curl -fsSL -o /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip" && \
    unzip /tmp/xray.zip -d /tmp/xray && \
    mv /tmp/xray/xray /usr/local/bin/xray && \
    chmod +x /usr/local/bin/xray && \
    rm -rf /tmp/xray /tmp/xray.zip

COPY config.json /usr/local/etc/xray/config.json

ENV PORT=8080
EXPOSE 8080

CMD ["/usr/local/bin/xray", "run", "-config", "/usr/local/etc/xray/config.json"]
