import http from "node:http";

const objects = new Map();
let sequence = 0;
let control = {mode: "ok", remaining: 0, delayMs: 0, skip: 0};

function reply(response, status, payload) {
  response.writeHead(status, {"content-type": "application/json"});
  response.end(JSON.stringify(payload));
}

function fileBytes(body, contentType) {
  if (!contentType.startsWith("multipart/form-data")) return body;
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/u);
  if (!boundary) throw new Error("Missing multipart boundary");
  const start = body.indexOf(Buffer.from("\r\n\r\n")) + 4;
  const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary[1] || boundary[2]}`));
  if (start < 4 || end < start) throw new Error("Missing multipart photo");
  return body.subarray(start, end);
}

async function readBody(request, response) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 3 * 1024 * 1024) { reply(response, 413, {error: "Fixture upload too large"}); return null; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleUpload(request, response, body) {
  const token = String(request.headers.authorization || "").replace(/^Bearer /u, "");
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); }
  catch { reply(response, 401, {error: "Invalid fixture authorization"}); return; }
  const mode = control.skip > 0 || control.remaining <= 0 ? "ok" : control.mode;
  if (control.skip > 0) control.skip -= 1;
  else if (control.remaining > 0) control.remaining -= 1;
  if (mode === "reject") { reply(response, 503, {error: "Fixture storage unavailable"}); return; }
  if (mode === "disconnect") { request.socket.destroy(); return; }
  if (mode === "hang") { return; }
  const bytes = fileBytes(body, String(request.headers["content-type"] || ""));
  const key = `${claims.keyPrefix || "fixture"}/photo-${sequence += 1}.jpg`;
  objects.set(key, bytes);
  if (control.delayMs > 0) await new Promise(resolve => setTimeout(resolve, control.delayMs));
  if (mode === "invalid") { response.writeHead(200); response.end("invalid response"); return; }
  reply(response, 200, {key, byteSize: bytes.length});
}

http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Name");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  const url = new URL(request.url, "http://fixture");
  if (url.pathname === "/health") { reply(response, 200, {ok: true}); return; }
  if (url.pathname === "/object") {
    const bytes = objects.get(url.searchParams.get("key"));
    if (!bytes) { reply(response, 404, {error: "Fixture object not found"}); return; }
    response.writeHead(200, {"content-type": "image/jpeg", "content-length": bytes.length});
    response.end(bytes);
    return;
  }
  if (request.method !== "POST") { reply(response, 404, {error: "Not found"}); return; }
  const body = await readBody(request, response);
  if (!body) return;
  if (url.pathname === "/control") {
    control = {...control, ...JSON.parse(body.toString())};
    reply(response, 200, {ok: true});
    return;
  }
  if (url.pathname !== "/upload") { reply(response, 404, {error: "Not found"}); return; }
  await handleUpload(request, response, body);
}).listen(3999, "0.0.0.0");
