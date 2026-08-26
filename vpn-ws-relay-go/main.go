package main

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultPort    = "8080"
	defaultWSPath  = "/api/v1/socket"
	defaultPingMS  = "25000"
	wsReadLimit    = 16 * 1024 * 1024
	copyBufferSize = 64 * 1024
	wsPongWait     = 90 * time.Second
	wsWriteWait    = 30 * time.Second
	tcpDialTimeout = 10 * time.Second
	tcpKeepAlive   = 30 * time.Second
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  copyBufferSize,
	WriteBufferSize: copyBufferSize,
}

func main() {
	port := envOr("PORT", defaultPort)
	upstreamMode := strings.ToLower(strings.TrimSpace(envOr("UPSTREAM_MODE", "tcp")))
	wsPath := envOr("WS_PATH", defaultWSPath)

	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte("ok"))
			return
		}

		if r.URL.Path != wsPath {
			http.NotFound(w, r)
			return
		}

		if !websocket.IsWebSocketUpgrade(r) {
			http.Error(w, "Bad Request", http.StatusBadRequest)
			return
		}

		switch upstreamMode {
		case "tcp", "ss":
			handleWsToTcp(w, r)
		case "ws":
			handleWsToWs(w, r)
		default:
			log.Printf("unknown UPSTREAM_MODE=%q, fallback to tcp", upstreamMode)
			handleWsToTcp(w, r)
		}
	})

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	log.Printf("vpn-ws-relay-go listening on :%s mode=%s path=%s", port, upstreamMode, wsPath)

	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func envOr(key, fallback string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	return v
}

func pingInterval() time.Duration {
	ms := envOr("RELAY_WS_PING_MS", defaultPingMS)
	n, err := time.ParseDuration(ms + "ms")
	if err != nil || n < time.Second {
		return 25 * time.Second
	}
	return n
}

func resolveTcpUpstreamAddr() (string, error) {
	if addr := strings.TrimSpace(os.Getenv("UPSTREAM_ADDR")); addr != "" {
		return addr, nil
	}

	host := envOr("UPSTREAM_SS_HOST", "")
	port := envOr("UPSTREAM_SS_PORT", "")
	if host == "" || port == "" {
		return "", &net.AddrError{
			Err:  "UPSTREAM_ADDR or UPSTREAM_SS_HOST/UPSTREAM_SS_PORT required",
			Addr: "upstream",
		}
	}

	return net.JoinHostPort(host, port), nil
}

func dialTcpUpstream() (net.Conn, error) {
	upstreamAddr, err := resolveTcpUpstreamAddr()
	if err != nil {
		return nil, err
	}

	dialer := &net.Dialer{
		Timeout:   tcpDialTimeout,
		KeepAlive: tcpKeepAlive,
	}

	conn, err := dialer.Dial("tcp4", upstreamAddr)
	if err != nil {
		return nil, err
	}

	if tcpConn, ok := conn.(*net.TCPConn); ok {
		_ = tcpConn.SetNoDelay(true)
		_ = tcpConn.SetKeepAlive(true)
		_ = tcpConn.SetKeepAlivePeriod(tcpKeepAlive)
	}

	return conn, nil
}

func prepareWebSocket(conn *websocket.Conn) {
	conn.SetReadLimit(wsReadLimit)
	_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})
}

func handleWsToTcp(w http.ResponseWriter, r *http.Request) {
	clientConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("client upgrade error: %v", err)
		return
	}
	defer clientConn.Close()

	prepareWebSocket(clientConn)

	upstream, err := dialTcpUpstream()
	if err != nil {
		log.Printf("tcp upstream dial error: %v", err)
		_ = clientConn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "upstream error"),
			time.Now().Add(time.Second),
		)
		return
	}
	defer upstream.Close()

	done := make(chan struct{})
	var once sync.Once
	closeDone := func() {
		once.Do(func() {
			close(done)
		})
	}

	var wsWriteMu sync.Mutex

	go wsPingLoop(clientConn, &wsWriteMu, done, closeDone)

	go func() {
		defer closeDone()

		buf := make([]byte, copyBufferSize)

		for {
			msgType, reader, err := clientConn.NextReader()
			if err != nil {
				if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
					log.Printf("ws read error: %v", err)
				}
				return
			}

			if msgType != websocket.BinaryMessage && msgType != websocket.TextMessage {
				continue
			}

			if _, err := io.CopyBuffer(upstream, reader, buf); err != nil {
				log.Printf("copy ws->tcp error: %v", err)
				return
			}
		}
	}()

	go func() {
		defer closeDone()

		buf := make([]byte, copyBufferSize)

		for {
			n, err := upstream.Read(buf)
			if n > 0 {
				wsWriteMu.Lock()
				_ = clientConn.SetWriteDeadline(time.Now().Add(wsWriteWait))
				wr, werr := clientConn.NextWriter(websocket.BinaryMessage)
				if werr == nil {
					_, werr = wr.Write(buf[:n])
					if cerr := wr.Close(); werr == nil {
						werr = cerr
					}
				}
				wsWriteMu.Unlock()

				if werr != nil {
					log.Printf("copy tcp->ws write error: %v", werr)
					return
				}
			}

			if err != nil {
				if err != io.EOF {
					log.Printf("tcp read error: %v", err)
				}
				return
			}
		}
	}()

	<-done

	wsWriteMu.Lock()
	_ = clientConn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		time.Now().Add(3*time.Second),
	)
	wsWriteMu.Unlock()
}

func wsPingLoop(conn *websocket.Conn, writeMu *sync.Mutex, done <-chan struct{}, closeDone func()) {
	ticker := time.NewTicker(pingInterval())
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			writeMu.Lock()
			err := conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(5*time.Second))
			writeMu.Unlock()

			if err != nil {
				log.Printf("ws ping error: %v", err)
				closeDone()
				return
			}

		case <-done:
			return
		}
	}
}

func resolveWsUpstreamURL(requestPath string) (string, bool) {
	path := strings.Split(requestPath, "?")[0]
	if path == "" {
		path = "/"
	}

	routesRaw := strings.TrimSpace(os.Getenv("UPSTREAM_ROUTES"))
	if routesRaw != "" {
		var routes map[string]string
		if err := json.Unmarshal([]byte(routesRaw), &routes); err == nil {
			for _, key := range []string{path, strings.TrimSuffix(path, "/"), path + "/"} {
				if key == "" {
					continue
				}
				if u, ok := routes[key]; ok && strings.TrimSpace(u) != "" {
					return strings.TrimSpace(u), true
				}
			}
			return "", false
		}
	}

	single := strings.TrimSpace(os.Getenv("UPSTREAM_WS_URL"))
	if single != "" {
		return single, true
	}

	return "", false
}

func handleWsToWs(w http.ResponseWriter, r *http.Request) {
	upstreamURL, ok := resolveWsUpstreamURL(r.URL.Path)
	if !ok {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}

	clientConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("client upgrade error: %v", err)
		return
	}
	defer clientConn.Close()

	prepareWebSocket(clientConn)

	dialer := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
		ReadBufferSize:   copyBufferSize,
		WriteBufferSize:  copyBufferSize,
	}

	header := http.Header{}
	if h := r.Host; h != "" {
		header.Set("Host", h)
	}

	upstreamConn, _, err := dialer.Dial(upstreamURL, header)
	if err != nil {
		log.Printf("upstream ws dial error (%s): %v", upstreamURL, err)
		return
	}
	defer upstreamConn.Close()

	prepareWebSocket(upstreamConn)

	done := make(chan struct{})
	var once sync.Once
	closeDone := func() {
		once.Do(func() {
			close(done)
		})
	}

	var clientWriteMu sync.Mutex
	var upstreamWriteMu sync.Mutex

	go wsPingLoop(clientConn, &clientWriteMu, done, closeDone)
	go wsPingLoop(upstreamConn, &upstreamWriteMu, done, closeDone)

	go func() {
		defer closeDone()
		pipeWsToWs(clientConn, upstreamConn, &upstreamWriteMu)
	}()

	go func() {
		defer closeDone()
		pipeWsToWs(upstreamConn, clientConn, &clientWriteMu)
	}()

	<-done
}

func pipeWsToWs(src *websocket.Conn, dst *websocket.Conn, dstWriteMu *sync.Mutex) {
	buf := make([]byte, copyBufferSize)
	for {
		msgType, reader, err := src.NextReader()
		if err != nil {
			return
		}

		if msgType != websocket.BinaryMessage && msgType != websocket.TextMessage {
			continue
		}

		dstWriteMu.Lock()
		_ = dst.SetWriteDeadline(time.Now().Add(wsWriteWait))
		writer, err := dst.NextWriter(websocket.BinaryMessage)
		if err == nil {
			_, err = io.CopyBuffer(writer, reader, buf)
			if cerr := writer.Close(); err == nil {
				err = cerr
			}
		}
		dstWriteMu.Unlock()

		if err != nil {
			return
		}
	}
}
