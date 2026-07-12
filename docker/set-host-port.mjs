import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = String(process.argv[2] || "").trim();
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("Provide a valid host port, for example: node docker/set-host-port.mjs 3000");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, "docker", "env", ".env");
const source = await fs.readFile(envPath, "utf8");
const line = `MBBS_APP_HOST_PORT=${port}`;
const output = /^MBBS_APP_HOST_PORT=.*$/m.test(source)
  ? source.replace(/^MBBS_APP_HOST_PORT=.*$/m, line)
  : `${source.trimEnd()}\n${line}\n`;
await fs.writeFile(envPath, output, { encoding: "utf8", mode: 0o600 });
console.log(`Docker app host port set to ${port}.`);
