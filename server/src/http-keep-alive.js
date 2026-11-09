// The Cloudflare tunnel (cloudflared) reuses an idle connection to the app for up to 90 s. Node closes
// idle keep-alive connections after 5 s by default, so a request cloudflared sent on a connection the app
// was just closing failed with "Unable to reach the origin service: EOF" and the caller got a 502
// (about 10 a day, including NetSuite order webhooks). Keeping idle connections open longer than
// cloudflared does means cloudflared always closes them first.
export const ORIGIN_KEEP_ALIVE_TIMEOUT_MS = 120_000;

/** @template {import("node:http").Server} T @param {T} server @returns {T} */
export function applyOriginKeepAlive(server) {
  server.keepAliveTimeout = ORIGIN_KEEP_ALIVE_TIMEOUT_MS;
  return server;
}
