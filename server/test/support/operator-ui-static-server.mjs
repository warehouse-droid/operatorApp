import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

if (process.env.MBT_TEST_ISOLATED !== "1") {
  throw new Error("The static UI fixture is restricted to isolated tests.");
}
const publicRoot = path.resolve("public");
createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/health") {
    response.writeHead(200).end("ok");
    return;
  }
  const filename = pathname === "/operator" ? "operator.html" : pathname.slice(1);
  const target = path.resolve(publicRoot, filename);
  if (!target.startsWith(`${publicRoot}${path.sep}`)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(target);
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    response.writeHead(200, { "content-type": types[path.extname(target)] || "application/octet-stream" });
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
}).listen(3000, "0.0.0.0");
