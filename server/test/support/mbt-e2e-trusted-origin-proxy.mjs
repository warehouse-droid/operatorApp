import http from "node:http";

const target = new URL(process.env.MBT_TEST_TRUSTED_PROXY_TARGET || "http://mbt-web:3000");
const port = Number(process.env.MBT_TEST_TRUSTED_PROXY_PORT || 3100);

const server = http.createServer((request, response) => {
  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: request.url,
    headers: {
      ...request.headers,
      host: target.host
    }
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on("error", (error) => {
    if (response.headersSent) {
      return response.destroy(error);
    }
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Trusted-origin proxy failed: ${error.message}`);
  });
  request.pipe(upstream);
});

server.listen(port, "127.0.0.1");

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
