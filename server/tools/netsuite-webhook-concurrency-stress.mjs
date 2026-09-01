import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";

import { closeDb, query } from "../src/db.js";

const REQUEST_COUNT = 50;
const ENTITY_COUNT = 35;
const VERSIONED_ENTITY_COUNT = 10;
const DUPLICATE_COUNT = 5;
const ACK_P95_LIMIT_MS = 1_000;
const ACK_MAXIMUM_LIMIT_MS = 5_000;
const ARTIFACT_DIRECTORY = new URL("../test-artifacts/netsuite-webhook-concurrency/", import.meta.url);
const RUN_ARTIFACT = new URL("run.json", ARTIFACT_DIRECTORY);
const FINAL_ARTIFACT = new URL("result.json", ARTIFACT_DIRECTORY);
const RESOURCE_ARTIFACT = new URL("resources.json", ARTIFACT_DIRECTORY);
const TEST_SECRET = "mbt_test_webhook_stress_secret";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] || 0;
}

function assertIsolated() {
  const database = new URL(String(process.env.DATABASE_URL || "postgres://invalid/invalid"));
  const target = new URL(String(process.env.MBT_WEBHOOK_STRESS_BASE_URL || "http://app:3000"));
  assert.equal(process.env.MBT_TEST_ISOLATED, "1", "stress test requires MBT_TEST_ISOLATED=1");
  assert.equal(database.hostname, "db", "stress test database host must be the disposable Compose service");
  assert.equal(database.pathname, "/mbt_test", "stress test database must be mbt_test");
  assert.ok(["app", "mbt-web"].includes(target.hostname), "stress target must be the disposable app service");
  assert.equal(target.protocol, "http:", "stress target must use the isolated HTTP network");
  assert.equal(process.env.NETSUITE_WEBHOOK_SECRET, TEST_SECRET, "stress test requires the test-only webhook secret");
  return target;
}

async function writeJson(url, value) {
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
  await writeFile(url, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function waitForHealth(target) {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await httpRequest({ target, path: "/health", method: "GET" });
      if (result.statusCode === 200) {
        return;
      }
      lastError = new Error(`health returned ${result.statusCode}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Disposable app did not become healthy: ${lastError?.message || "timeout"}`);
}

function httpRequest({ target, path, method, payload, secret, agent }) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || "80",
      path,
      method,
      agent,
      headers: {
        accept: "application/json",
        ...(body ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        } : {}),
        ...(secret ? { "x-mbbs-webhook-secret": secret } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let parsedBody = null;
        try {
          parsedBody = rawBody ? JSON.parse(rawBody) : null;
        } catch {
          parsedBody = { rawBody };
        }
        resolve({
          statusCode: Number(response.statusCode || 0),
          body: parsedBody,
          latencyMs: performance.now() - startedAt
        });
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error("HTTP request exceeded 10 seconds.")));
    request.once("error", reject);
    request.end(body);
  });
}

function requestPayload({ runId, idBase, entityIndex, quantity, version }) {
  const modifiedAt = new Date(Date.UTC(2026, 7, 28, 12, entityIndex, version)).toISOString();
  return {
    recordType: "sales_order",
    id: String(idBase + BigInt(entityIndex)),
    tranid: `WHS50-${runId}-${String(entityIndex).padStart(2, "0")}`,
    eventType: version === 1 ? "create" : "edit",
    lastModifiedDate: modifiedAt,
    stressRunId: runId,
    stressEntityIndex: entityIndex,
    trandate: "2026-08-28",
    entityId: 700_000 + entityIndex,
    entityText: `Disposable stress customer ${entityIndex}`,
    status: "SalesOrd:B",
    statusText: "Pending Fulfillment",
    locationId: 12441,
    locationText: "Disposable yard 12441",
    deliveryMethodText: "Delivery",
    memo: "Disposable 50-request webhook stress test",
    lines: [{
      lineUniqueKey: entityIndex,
      itemId: 910_000 + entityIndex,
      itemName: `WHS50-ITEM-${entityIndex}`,
      sku: `WHS50-SKU-${entityIndex}`,
      quantity,
      quantityFulfilled: 0,
      unit: "EA",
      pallet_qty: quantity,
      locationId: 12441,
      locationText: "Disposable yard 12441"
    }]
  };
}

function workload(runId) {
  const idBase = BigInt(Date.now()) * 100n;
  const base = Array.from({ length: ENTITY_COUNT }, (_, offset) => ({
    label: `entity-${offset + 1}-v1`,
    kind: "base",
    payload: requestPayload({ runId, idBase, entityIndex: offset + 1, quantity: 1, version: 1 })
  }));
  const newer = base.slice(0, VERSIONED_ENTITY_COUNT).map((entry, offset) => ({
    label: `entity-${offset + 1}-v2`,
    kind: "newer",
    payload: requestPayload({ runId, idBase, entityIndex: offset + 1, quantity: 2, version: 2 })
  }));
  const duplicates = base.slice(VERSIONED_ENTITY_COUNT, VERSIONED_ENTITY_COUNT + DUPLICATE_COUNT).map((entry) => ({
    label: `${entry.label}-duplicate`,
    kind: "duplicate",
    payload: structuredClone(entry.payload)
  }));
  const requests = [...base, ...newer, ...duplicates];
  requests.sort((left, right) => crypto.createHash("sha256").update(`${runId}:${left.label}`).digest("hex")
    .localeCompare(crypto.createHash("sha256").update(`${runId}:${right.label}`).digest("hex")));
  assert.equal(requests.length, REQUEST_COUNT);
  return requests;
}

async function queueCounts(runId) {
  const result = await query(
    `SELECT count(*)::int AS total,
            count(DISTINCT entity_key)::int AS entities,
            count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'running')::int AS running,
            count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'superseded')::int AS superseded,
            COALESCE(max(attempt_count), 0)::int AS maximum_attempt_count
       FROM netsuite_order_webhook_inbox
      WHERE payload ->> 'stressRunId' = $1`,
    [runId]
  );
  return result.rows[0];
}

async function runIngress() {
  const target = assertIsolated();
  await waitForHealth(target);
  await query("TRUNCATE netsuite_order_webhook_attempts, netsuite_order_webhook_inbox RESTART IDENTITY CASCADE");
  await query(
    `UPDATE netsuite_order_webhook_control
        SET paused = false, pause_reason = '', updated_by = 'webhook-stress', updated_at = now()
      WHERE singleton = true`
  );

  const runId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const requests = workload(runId);
  const unauthorized = await httpRequest({
    target,
    path: "/api/webhooks/netsuite/order",
    method: "POST",
    payload: requests[0].payload,
    secret: "mbt_test_invalid_secret"
  });
  assert.equal(unauthorized.statusCode, 401, "invalid webhook secret must be rejected");
  const malformed = await httpRequest({
    target,
    path: "/api/webhooks/netsuite/order",
    method: "POST",
    payload: { recordType: "sales_order", tranid: `WHS50-${runId}-MALFORMED` },
    secret: TEST_SECRET
  });
  assert.equal(malformed.statusCode, 400, "malformed authenticated webhook must be rejected");
  assert.equal(Number((await queueCounts(runId)).total), 0, "rejected requests must not enter the queue");

  const agent = new http.Agent({ keepAlive: false, maxSockets: REQUEST_COUNT, maxTotalSockets: REQUEST_COUNT });
  let releaseBarrier;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });
  let ready = 0;
  let active = 0;
  let maximumInFlight = 0;
  const startOffsets = [];
  const responses = requests.map((entry) => (async () => {
    ready += 1;
    await barrier;
    active += 1;
    maximumInFlight = Math.max(maximumInFlight, active);
    startOffsets.push(performance.now());
    try {
      const response = await httpRequest({
        target,
        path: "/api/webhooks/netsuite/order",
        method: "POST",
        payload: entry.payload,
        secret: TEST_SECRET,
        agent
      });
      return { label: entry.label, kind: entry.kind, ...response };
    } finally {
      active -= 1;
    }
  })());
  assert.equal(ready, REQUEST_COUNT, "all clients must be waiting at the release barrier");
  await sleep(1_200);
  const batchStartedAt = performance.now();
  releaseBarrier();
  const completed = await Promise.all(responses);
  const batchWallMs = performance.now() - batchStartedAt;
  agent.destroy();
  await sleep(1_200);

  assert.equal(maximumInFlight, REQUEST_COUNT, "all 50 HTTP operations must be in flight together");
  assert.deepEqual([...new Set(completed.map((response) => response.statusCode))], [202]);
  assert.ok(completed.every((response) => response.body?.accepted === true), "every valid request must be accepted");
  const latencies = completed.map((response) => response.latencyMs);
  const p95Ms = percentile(latencies, 0.95);
  const maximumMs = Math.max(...latencies);
  assert.ok(p95Ms < ACK_P95_LIMIT_MS, `HTTP acknowledgement p95 ${p95Ms.toFixed(3)}ms exceeded ${ACK_P95_LIMIT_MS}ms`);
  assert.ok(maximumMs < ACK_MAXIMUM_LIMIT_MS, `HTTP acknowledgement maximum ${maximumMs.toFixed(3)}ms exceeded ${ACK_MAXIMUM_LIMIT_MS}ms`);
  const duplicateResponses = completed.filter((response) => response.body?.duplicate === true).length;
  const versionDecisions = completed.reduce(
    (total, response) => total + Number(response.body?.coalesced || 0) + Number(response.body?.superseded === true),
    0
  );
  assert.equal(duplicateResponses, DUPLICATE_COUNT, "exactly five duplicate HTTP calls must be idempotent");
  assert.equal(versionDecisions, VERSIONED_ENTITY_COUNT, "each two-version entity must make one version decision");

  const counts = await queueCounts(runId);
  assert.deepEqual(
    {
      total: Number(counts.total),
      entities: Number(counts.entities),
      queued: Number(counts.queued),
      running: Number(counts.running),
      succeeded: Number(counts.succeeded),
      failed: Number(counts.failed),
      superseded: Number(counts.superseded)
    },
    { total: 45, entities: 35, queued: 35, running: 0, succeeded: 0, failed: 0, superseded: 10 }
  );
  await query(
    `UPDATE netsuite_order_webhook_control
        SET paused = true,
            pause_reason = 'worker startup barrier for disposable stress test',
            updated_by = 'webhook-stress',
            updated_at = now()
      WHERE singleton = true`
  );

  const evidence = {
    generatedAt: new Date().toISOString(),
    runId,
    target: `${target.protocol}//${target.host}`,
    contract: {
      requests: REQUEST_COUNT,
      entities: ENTITY_COUNT,
      versionedEntities: VERSIONED_ENTITY_COUNT,
      exactDuplicates: DUPLICATE_COUNT
    },
    rejectionChecks: {
      unauthorizedStatus: unauthorized.statusCode,
      malformedStatus: malformed.statusCode,
      rejectedRows: 0
    },
    concurrency: {
      barrierParticipants: ready,
      maximumClientInFlight: maximumInFlight,
      startSpreadMs: Number((Math.max(...startOffsets) - Math.min(...startOffsets)).toFixed(3)),
      batchWallMs: Number(batchWallMs.toFixed(3))
    },
    acknowledgement: {
      status202: completed.length,
      minimumMs: Number(Math.min(...latencies).toFixed(3)),
      averageMs: Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(3)),
      p95Ms: Number(p95Ms.toFixed(3)),
      maximumMs: Number(maximumMs.toFixed(3)),
      p95LimitMs: ACK_P95_LIMIT_MS,
      maximumLimitMs: ACK_MAXIMUM_LIMIT_MS
    },
    coalescing: { duplicateResponses, versionDecisions },
    queueBeforeWorkers: counts,
    requests: completed.map((response) => ({
      label: response.label,
      kind: response.kind,
      statusCode: response.statusCode,
      latencyMs: Number(response.latencyMs.toFixed(3)),
      duplicate: response.body?.duplicate === true,
      superseded: response.body?.superseded === true,
      coalesced: Number(response.body?.coalesced || 0)
    }))
  };
  await writeJson(RUN_ARTIFACT, evidence);
  console.log(JSON.stringify(evidence, null, 2));
}

async function runVerification() {
  assertIsolated();
  const ingress = JSON.parse(await readFile(RUN_ARTIFACT, "utf8"));
  const { runId } = ingress;
  assert.ok(runId, "ingress run artifact must identify the test run");
  await sleep(1_000);
  await query(
    `UPDATE netsuite_order_webhook_control
        SET paused = false, pause_reason = '', updated_by = 'webhook-stress', updated_at = now()
      WHERE singleton = true`
  );

  const startedAt = performance.now();
  const deadline = Date.now() + 120_000;
  let maximumObservedRunning = 0;
  let counts = await queueCounts(runId);
  while (Date.now() < deadline) {
    counts = await queueCounts(runId);
    maximumObservedRunning = Math.max(maximumObservedRunning, Number(counts.running));
    if (Number(counts.failed) > 0) {
      const failures = await query(
        `SELECT id::text, entity_key, last_error
           FROM netsuite_order_webhook_inbox
          WHERE payload ->> 'stressRunId' = $1 AND status = 'failed'
          ORDER BY id`,
        [runId]
      );
      throw new Error(`Webhook worker failed: ${JSON.stringify(failures.rows)}`);
    }
    if (Number(counts.queued) === 0 && Number(counts.running) === 0) {
      break;
    }
    await sleep(100);
  }
  const drainWallMs = performance.now() - startedAt;
  assert.deepEqual(
    {
      total: Number(counts.total),
      entities: Number(counts.entities),
      queued: Number(counts.queued),
      running: Number(counts.running),
      succeeded: Number(counts.succeeded),
      failed: Number(counts.failed),
      superseded: Number(counts.superseded)
    },
    { total: 45, entities: 35, queued: 0, running: 0, succeeded: 35, failed: 0, superseded: 10 }
  );
  assert.ok(maximumObservedRunning <= 1, `observed ${maximumObservedRunning} simultaneous running rows`);

  const attempts = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE outcome = 'succeeded')::int AS succeeded,
            count(*) FILTER (WHERE outcome <> 'succeeded')::int AS other,
            count(DISTINCT worker_id)::int AS workers_used,
            array_agg(DISTINCT worker_id ORDER BY worker_id) AS worker_ids,
            COALESCE(max(attempt_number), 0)::int AS maximum_attempt_number
       FROM netsuite_order_webhook_attempts attempt
       JOIN netsuite_order_webhook_inbox inbox ON inbox.id = attempt.inbox_id
      WHERE inbox.payload ->> 'stressRunId' = $1`,
    [runId]
  );
  const overlap = await query(
    `SELECT count(*)::int AS overlaps
       FROM netsuite_order_webhook_attempts left_attempt
       JOIN netsuite_order_webhook_inbox left_inbox ON left_inbox.id = left_attempt.inbox_id
       JOIN netsuite_order_webhook_attempts right_attempt ON right_attempt.id > left_attempt.id
       JOIN netsuite_order_webhook_inbox right_inbox ON right_inbox.id = right_attempt.inbox_id
      WHERE left_inbox.payload ->> 'stressRunId' = $1
        AND right_inbox.payload ->> 'stressRunId' = $1
        AND left_attempt.started_at < right_attempt.finished_at
        AND right_attempt.started_at < left_attempt.finished_at`,
    [runId]
  );
  assert.equal(Number(attempts.rows[0].total), ENTITY_COUNT);
  assert.equal(Number(attempts.rows[0].succeeded), ENTITY_COUNT);
  assert.equal(Number(attempts.rows[0].other), 0);
  assert.equal(Number(attempts.rows[0].maximum_attempt_number), 1);
  assert.equal(Number(overlap.rows[0].overlaps), 0, "worker attempt intervals must never overlap");

  const prefix = `WHS50-${runId}-`;
  const mapped = await query(
    `SELECT sales.netsuite_id::text AS netsuite_id,
            sales.tranid,
            (inbox.payload ->> 'stressEntityIndex')::int AS entity_index,
            count(line.id)::int AS line_count,
            max(line.quantity)::float8 AS quantity
       FROM sales_orders sales
       JOIN netsuite_order_webhook_inbox inbox
         ON inbox.netsuite_order_id = sales.netsuite_id::text
        AND inbox.status = 'succeeded'
       LEFT JOIN sales_order_lines line ON line.sales_order_id = sales.netsuite_id
      WHERE inbox.payload ->> 'stressRunId' = $1
        AND sales.tranid LIKE $2
      GROUP BY sales.netsuite_id, sales.tranid, (inbox.payload ->> 'stressEntityIndex')::int
      ORDER BY entity_index`,
    [runId, `${prefix}%`]
  );
  assert.equal(mapped.rowCount, ENTITY_COUNT, "every retained entity must map to one sales order");
  for (const row of mapped.rows) {
    assert.equal(Number(row.line_count), 1, `${row.tranid} must have exactly one active line`);
    const expectedQuantity = Number(row.entity_index) <= VERSIONED_ENTITY_COUNT ? 2 : 1;
    assert.equal(Number(row.quantity), expectedQuantity, `${row.tranid} did not retain its newest quantity`);
  }
  await sleep(1_000);

  const evidence = {
    generatedAt: new Date().toISOString(),
    runId,
    ingress: ingress.acknowledgement,
    queueAfterWorkers: counts,
    drain: {
      wallMs: Number(drainWallMs.toFixed(3)),
      maximumObservedRunning,
      configuredCompetingWorkers: 4,
      attempts: attempts.rows[0],
      overlappingAttemptPairs: Number(overlap.rows[0].overlaps)
    },
    mapped: {
      salesOrders: mapped.rowCount,
      salesOrderLines: mapped.rows.reduce((total, row) => total + Number(row.line_count), 0),
      newestVersionQuantitiesVerified: VERSIONED_ENTITY_COUNT
    }
  };
  await writeJson(FINAL_ARTIFACT, evidence);
  console.log(JSON.stringify(evidence, null, 2));
}

function bytes(value) {
  const match = String(value || "").trim().match(/^([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB)$/u);
  if (!match) {
    return 0;
  }
  const factors = {
    B: 1,
    kB: 1_000,
    KiB: 1_024,
    MB: 1_000_000,
    MiB: 1_048_576,
    GB: 1_000_000_000,
    GiB: 1_073_741_824
  };
  return Number(match[1]) * factors[match[2]];
}

async function summarizeResources() {
  assertIsolated();
  const phases = ["ingress", "drain"];
  const summary = {};
  for (const phase of phases) {
    const source = new URL(`${phase}-docker-stats.ndjson`, ARTIFACT_DIRECTORY);
    const rows = (await readFile(source, "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").trim())
      .filter((line) => line.startsWith("{") && line.endsWith("}"))
      .map((line) => JSON.parse(line));
    summary[phase] = {};
    for (const row of rows) {
      const name = String(row.Name || row.Container || row.ID || "unknown");
      const memory = String(row.MemUsage || "0B / 0B").split("/")[0].trim();
      summary[phase][name] ||= { samples: 0, maximumCpuPercent: 0, maximumMemoryBytes: 0 };
      summary[phase][name].samples += 1;
      summary[phase][name].maximumCpuPercent = Math.max(
        summary[phase][name].maximumCpuPercent,
        Number.parseFloat(String(row.CPUPerc || "0").replace("%", "")) || 0
      );
      summary[phase][name].maximumMemoryBytes = Math.max(summary[phase][name].maximumMemoryBytes, bytes(memory));
    }
  }
  await writeJson(RESOURCE_ARTIFACT, { generatedAt: new Date().toISOString(), phases: summary });
  console.log(JSON.stringify(summary, null, 2));
}

const mode = process.argv[2];
try {
  if (mode === "ingress") {
    await runIngress();
  } else if (mode === "verify") {
    await runVerification();
  } else if (mode === "resources") {
    await summarizeResources();
  } else {
    throw new Error("Usage: node tools/netsuite-webhook-concurrency-stress.mjs <ingress|verify|resources>");
  }
} finally {
  await closeDb();
}
