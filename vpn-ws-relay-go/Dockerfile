FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download 2>/dev/null || true
COPY . .
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /vpn-ws-relay-go .

FROM gcr.io/distroless/static-debian12
WORKDIR /app
COPY --from=build /vpn-ws-relay-go /app/vpn-ws-relay-go
ENV PORT=8080
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/app/vpn-ws-relay-go"]
