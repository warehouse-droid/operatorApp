// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.env.MBBS_REPO_ROOT || path.resolve(process.cwd(), "..");

test("WL-09 Compose hard-limits Ollama to two CPUs and the serial webhook worker to one", async () => {
  const compose = await readFile(path.join(root, "docker-compose.yml"), "utf8");
  assert.match(compose, /ollama:[\s\S]*?cpus:\s*["']?2(?:\.0)?["']?/u);
  assert.match(compose, /ollama:[\s\S]*?OLLAMA_NUM_PARALLEL:\s*["']?1["']?/u);
  assert.match(compose, /webhook-worker:[\s\S]*?cpus:\s*["']?1(?:\.0)?["']?/u);
  assert.match(compose, /webhook-worker:[\s\S]*?NETSUITE_ORDER_WEBHOOK_WORKER_CONCURRENCY:\s*["']?1["']?/u);
  assert.match(compose, /webhook-worker:[\s\S]*?healthcheck:\s*\n\s+disable:\s*true/u,
    "the non-HTTP worker must not inherit the app HTTP healthcheck");
});

test("WL-10 printer polling bypasses fallback audit write amplification without hiding job transitions", async () => {
  const source = await readFile(path.join(process.cwd(), "src/server.js"), "utf8");
  assert.match(source, /isHighFrequencyPollRequest/u);
  assert.match(source, /\/api\/scm\/print-agent\/lease/u);
  assert.match(source, /\/heartbeat/u);
  assert.match(source, /writeDispatchAudit|writeAudit/u);
});

test("WL-26 durable order-webhook inbox replaces redundant per-request fallback audits", async () => {
  const source = await readFile(path.join(process.cwd(), "src/server.js"), "utf8");
  const start = source.indexOf("function isHighFrequencyPollRequest");
  assert.notEqual(start, -1);
  const end = source.indexOf("\n}\n", start);
  const bypass = source.slice(start, end + 3);
  assert.match(bypass, /\/api\/webhooks\/netsuite\/order/u);
  assert.match(source, /enqueueNetSuiteOrderWebhook/u);
});

test("WL-27 serial webhook worker suppresses duplicate in-process catalog event writes", async () => {
  const worker = await readFile(path.join(process.cwd(), "src/netsuite-order-webhook-worker.js"), "utf8");
  const server = await readFile(path.join(process.cwd(), "src/server.js"), "utf8");
  assert.match(worker, /processNetSuiteOrderWebhook\(job\.payload,\s*\{\s*emitEvents:\s*false\s*\}\)/u);
  assert.match(server, /processNetSuiteOrderWebhook\(payload\s*=\s*\{\},\s*\{[^}]*emitEvents\s*=\s*true/u);
});

test("WL-28 replay evidence includes a cold observation before warm p95 samples", async () => {
  const replay = await readFile(path.join(process.cwd(), "tools/application-workload-gauntlet.mjs"), "utf8");
  assert.match(replay, /coldMs/u);
  assert.match(replay, /coldMs\s*>=\s*SLA_MS/u);
});

test("WL-29 oversized snapshot history is pruned in small yielded chunks", async () => {
  const source = await readFile(path.join(process.cwd(), "src/server.js"), "utf8");
  const start = source.indexOf("export async function dispatchV2CheckpointRetentionTick");
  const end = source.indexOf("export async function dispatchV2CheckpointTick", start);
  const retention = source.slice(start, end);
  assert.match(retention, /batchSize:\s*5/u);
  assert.match(retention, /maxBatches:\s*20/u);
  assert.match(retention, /yieldBetween:[\s\S]*setTimeout/u);
  assert.match(source, /15\s*\*\s*60\s*\*\s*1000/u);
});

test("WL-30 disposable Compose exposes an isolated webhook stress worker", async () => {
  const compose = await readFile(path.join(root, "docker-compose.mbt-test.yml"), "utf8");
  assert.match(compose, /NETSUITE_WEBHOOK_SECRET:\s*mbt_test_webhook_stress_secret/u);
  assert.match(
    compose,
    /webhook-worker:[\s\S]*?command:\s*\["node",\s*"src\/netsuite-order-webhook-worker\.js"\][\s\S]*?profiles:\s*\["webhook-stress"\]/u
  );
  assert.match(
    compose,
    /webhook-worker:[\s\S]*?NETSUITE_ORDER_WEBHOOK_WORKER_CONCURRENCY:\s*["']?1["']?/u
  );
});
