import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Server smoke must use a disposable test database");
const folder = "test-artifacts/operator-posting-latency";
mkdirSync(folder, { recursive: true });
const child = spawn(process.execPath, ["--input-type=module", "-e", 'process.on("SIGINT", () => process.exit(0)); const {startServer} = await import("./src/server.js"); await startServer();'], { env: { ...process.env, PORT: "3137" }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", exit;
child.stdout.on("data", (value) => { logs += value; });
child.stderr.on("data", (value) => { logs += value; });
const stopped = new Promise((resolve) => child.once("exit", (code) => { exit = code; resolve(code); }));
try {
  let response;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    assert.equal(exit, undefined, logs);
    try {response = await fetch("http://127.0.0.1:3137/health"); break;} catch {await new Promise((resolve) => setTimeout(resolve, 250));}
  }
  assert.ok(response?.ok, logs);
  assert.deepEqual(await response.json(), { ok: true, app: "MBBS Yard Server" });
  await new Promise((resolve) => setTimeout(resolve, 5500));
  assert.equal(exit, undefined, logs);
  assert.doesNotMatch(logs, /operator_photo_worker_error/);
  writeFileSync(`${folder}/smoke.json`, JSON.stringify({ started: true, health: 200, photoWorkerPollsWithoutErrors: true, database: "isolated" }));
} finally {
  child.kill("SIGINT");
  await stopped;
  writeFileSync(`${folder}/smoke-server.log`, logs);
}
