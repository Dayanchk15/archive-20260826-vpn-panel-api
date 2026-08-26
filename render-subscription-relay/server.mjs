import http from "node:http";

const port = Number(process.env.PORT || 10000);
const originText = process.env.SUBSCRIPTION_ORIGIN || "https://sub.twidu.com";
const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);

let origin;
try {
  origin = new URL(originText);
} catch {
  throw new Error("SUBSCRIPTION_ORIGIN must be a valid URL");
}

if (origin.protocol !== "https:") {
  throw new Error("SUBSCRIPTION_ORIGIN must use HTTPS");
}

// This service is deliberately limited to the subscription API. It is not an
// open proxy and will never fetch arbitrary user-supplied URLs.
const subscriptionPath = /^\/api\/sub\/[A-Za-z0-9._~-]+$/;

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store, no-cache, must-revalidate",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function proxySubscription(req, res, pathname, search) {
  const upstream = new URL(pathname + search, origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstreamResponse = await fetch(upstream, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: req.headers.accept || "*/*",
        "user-agent": "subscription-relay/1.0"
      }
    });

    // A redirect would expose the old origin and defeat the purpose of this
    // endpoint, so return an error instead of forwarding it to clients.
    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      send(res, 502, "upstream returned redirect\n");
      return;
    }

    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    const contentType = upstreamResponse.headers.get("content-type") ||
      "text/plain; charset=utf-8";
    send(res, upstreamResponse.status, body, contentType);
  } catch (error) {
    const message = error?.name === "AbortError" ? "upstream timeout" : "upstream unavailable";
    send(res, 502, `${message}\n`);
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://relay.local");

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    send(res, 200, "OK\n");
    return;
  }

  if (req.method !== "GET") {
    send(res, 405, "method not allowed\n");
    return;
  }

  if (!subscriptionPath.test(requestUrl.pathname)) {
    send(res, 404, "not found\n");
    return;
  }

  await proxySubscription(req, res, requestUrl.pathname, requestUrl.search);
});

server.requestTimeout = timeoutMs + 5000;
server.headersTimeout = timeoutMs + 5000;
server.listen(port, "0.0.0.0", () => {
  console.log(`subscription relay listening on ${port}`);
});
