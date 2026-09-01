import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { closeDb, query, withTransaction } from "../src/db.js";
import {
  listDispatchOrderPool,
  replaceDispatchOrderCatalog
} from "../src/dispatch-order-catalog-repository.js";
import { pruneExpiredDispatchV2Checkpoints } from "../src/dispatch-planner-v2-repository.js";
import {
  claimNetSuiteOrderWebhook,
  completeNetSuiteOrderWebhook,
  enqueueNetSuiteOrderWebhook
} from "../src/netsuite-order-webhook-queue-repository.js";
import {
  getScmPurchaseOrderCatalogOrder,
  listScmPurchaseOrderCatalog,
  replaceScmPurchaseOrderCatalog
} from "../src/scm-purchase-order-catalog-repository.js";
import {
  buildAnonymizedWorkloadReplayPlan,
  validateAnonymizedWorkloadFixture
} from "../src/application-workload-replay.js";

const FIXTURE_URL = new URL("../test/fixtures/production-workload-2026-08-27.anonymized.json", import.meta.url);
const ARTIFACT_URL = new URL("../test-artifacts/application-workload-gauntlet.json", import.meta.url);
const PLAN_PREFIX = "application-workload-gauntlet-v1:";
const ORDER_COUNT = 3_000;
const PLAN_COUNT = 1_000;
const LATENCY_SAMPLES = 25;
const SLA_MS = 1_000;

function assertIsolated() {
  const databaseUrl = String(process.env.DATABASE_URL || "");
  if (process.env.MBT_TEST_ISOLATED !== "1" || !/\/mbt_test(?:\?|$)/u.test(databaseUrl)) {
    throw new Error("The application workload gauntlet may run only against the disposable mbt_test database.");
  }
}

function padded(value) {
  return String(value).padStart(4, "0");
}

function percentile(values, percent) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percent) - 1)] || 0;
}

async function samples(name, operation, validate) {
  const coldStartedAt = performance.now();
  const coldResult = await operation();
  const coldMs = Number((performance.now() - coldStartedAt).toFixed(3));
  validate(coldResult);
  for (let index = 0; index < 2; index += 1) await operation();
  const values = [];
  for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
    const startedAt = performance.now();
    const result = await operation();
    values.push(performance.now() - startedAt);
    validate(result);
  }
  const evidence = {
    name,
    coldMs,
    samples: values.length,
    minimumMs: Number(Math.min(...values).toFixed(3)),
    averageMs: Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maximumMs: Number(Math.max(...values).toFixed(3))
  };
  if (evidence.coldMs >= SLA_MS) {
    throw new Error(`${name} cold observation ${evidence.coldMs}ms exceeds the ${SLA_MS}ms SLA.`);
  }
  if (evidence.p95Ms >= SLA_MS) {
    throw new Error(`${name} p95 ${evidence.p95Ms}ms exceeds the ${SLA_MS}ms SLA.`);
  }
  return evidence;
}

async function seedPlansAndRetention() {
  await query("DELETE FROM dispatch_plans WHERE note LIKE $1", [`${PLAN_PREFIX}%`]);
  const inserted = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note, revision, created_at, updated_at)
     SELECT date '2600-01-01' + ordinal,
            'draft', $1 || ordinal::text, 1,
            now() - (ordinal::text || ' minutes')::interval,
            now() - (ordinal::text || ' minutes')::interval
       FROM generate_series(0, $2::int - 1) ordinal
     RETURNING id, plan_date`,
    [PLAN_PREFIX, PLAN_COUNT]
  );
  await query(
    `INSERT INTO dispatch_plan_snapshots (
       plan_id, orders, trucks, summary, schema_version, plan_digest,
       order_count, truck_count, load_count, stop_count, saved_at
     )
     SELECT plan.id, '[]'::jsonb, '[]'::jsonb, '{"workloadReplay":true}'::jsonb,
            2, '', 0, 0, 0, 0, now()
       FROM dispatch_plans plan
      WHERE plan.note LIKE $1`,
    [`${PLAN_PREFIX}%`]
  );
  await query(
    `INSERT INTO dispatch_plan_projection_state (plan_id, source_revision, projected_at)
     SELECT id, revision, now()
       FROM dispatch_plans
      WHERE note LIKE $1
     ON CONFLICT (plan_id) DO UPDATE
       SET source_revision = EXCLUDED.source_revision, projected_at = now()`,
    [`${PLAN_PREFIX}%`]
  );
  await query(
    `INSERT INTO dispatch_plan_order_assignments (
       plan_id, plan_date, order_ref, planned_order_ref, assignment_kind,
       load_id, stop_id, assignment, updated_at
     )
     SELECT plan.id, plan.plan_date, source.order_ref, source.order_ref, 'direct',
            'load-' || source.ordinal::text, 'stop-' || source.ordinal::text,
            jsonb_build_object('dispatchTruckPlate', 'WL-TRUCK', 'dispatchLoadName', 'Replay load'), now()
       FROM (
         SELECT id, plan_date, row_number() OVER (ORDER BY id)::int AS ordinal
           FROM dispatch_plans
          WHERE note LIKE $1
       ) plan
       CROSS JOIN LATERAL (
         VALUES
           ('WL-SO-' || lpad(plan.ordinal::text, 4, '0'), plan.ordinal),
           ('WL-PO-' || lpad(plan.ordinal::text, 4, '0'), plan.ordinal)
       ) source(order_ref, ordinal)
     ON CONFLICT (plan_id, order_ref) DO UPDATE
       SET plan_date = EXCLUDED.plan_date,
           planned_order_ref = EXCLUDED.planned_order_ref,
           assignment = EXCLUDED.assignment,
           updated_at = now()`,
    [`${PLAN_PREFIX}%`]
  );
  await query(
    `INSERT INTO dispatch_plan_snapshot_history (
       plan_id, plan_date, revision, orders, trucks, summary, archived_at,
       archive_reason, session_id, checkpoint_kind
     )
     SELECT plan.id, plan.plan_date, history.revision,
            '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
            now() - ((7 - history.revision)::text || ' minutes')::interval,
            'workload-periodic-' || history.revision::text,
            'application-workload-gauntlet', 'periodic'
       FROM dispatch_plans plan
       CROSS JOIN generate_series(1, 6) history(revision)
      WHERE plan.note LIKE $1`,
    [`${PLAN_PREFIX}%`]
  );
  await query(
    `INSERT INTO dispatch_plan_snapshot_history (
       plan_id, plan_date, revision, orders, trucks, summary, archived_at,
       archive_reason, session_id, checkpoint_kind, resolved_at
     )
     SELECT plan.id, plan.plan_date, 0,
            '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
            now() - interval '8 minutes', 'save_recovery',
            'application-workload-gauntlet', 'recovery', NULL
       FROM (
         SELECT id, plan_date, row_number() OVER (ORDER BY id) AS ordinal
           FROM dispatch_plans
          WHERE note LIKE $1
       ) plan
      WHERE plan.ordinal % 100 = 0`,
    [`${PLAN_PREFIX}%`]
  );
  return inserted.rowCount;
}

function dispatchOrders() {
  return Array.from({ length: ORDER_COUNT }, (_, offset) => {
    const ordinal = offset + 1;
    return {
      id: `WL-SO-${padded(ordinal)}`,
      type: "SO",
      customer: `Anonymous customer ${ordinal}`,
      expectedDeliveryDate: "2600-01-01",
      updatedAt: new Date(Date.UTC(2026, 7, 27, 0, 0, ordinal)).toISOString(),
      items: [{ sku: `WL-SKU-${padded(ordinal)}`, quantity: ordinal }]
    };
  });
}

function purchaseOrders() {
  return Array.from({ length: ORDER_COUNT }, (_, offset) => {
    const ordinal = offset + 1;
    return {
      id: `WL-PO-${padded(ordinal)}`,
      type: "PO",
      customer: `Anonymous vendor ${ordinal % 40}`,
      destinationYard: ordinal % 2 ? "12441" : "3445",
      sourceYard: `Anonymous pickup ${ordinal % 25}`,
      scmSearchRefs: [`WL-PO-${padded(ordinal)}`, `WL-PGOB-${padded(ordinal)}`],
      correspondingPoRefs: [`WL-SPLIT-${padded(ordinal)}`],
      updatedAt: new Date(Date.UTC(2026, 7, 27, 0, 0, ordinal)).toISOString(),
      items: [{ lineRowId: ordinal, sku: `WL-SKU-${padded(ordinal)}`, quantity: ordinal }]
    };
  });
}

async function replayCountShape(fixture) {
  const startedAt = performance.now();
  const totals = fixture.eventTotals || [];
  const result = await withTransaction(async () => {
    await query(
      `CREATE TEMP TABLE workload_replay_events (
         kind text NOT NULL,
         ordinal integer NOT NULL,
         evidence text NOT NULL
       ) ON COMMIT DROP`
    );
    await query(
      `INSERT INTO workload_replay_events (kind, ordinal, evidence)
       SELECT event.kind, ordinal,
              repeat('x', LEAST(event.average_evidence_bytes, 110000))
         FROM jsonb_to_recordset($1::jsonb) event(
           kind text, count integer, average_evidence_bytes integer
         )
         CROSS JOIN LATERAL generate_series(1, event.count) ordinal`,
      [JSON.stringify(totals.map((row) => ({
        kind: row.kind,
        count: row.count,
        average_evidence_bytes: row.averageEvidenceBytes
      })))]
    );
    return query(
      `SELECT count(*)::int AS events,
              COALESCE(sum(octet_length(evidence)), 0)::bigint AS evidence_bytes
         FROM workload_replay_events`
    );
  });
  return {
    events: Number(result.rows[0].events || 0),
    evidenceBytes: Number(result.rows[0].evidence_bytes || 0),
    wallMs: Number((performance.now() - startedAt).toFixed(3))
  };
}

function webhookEvents(fixture, runId) {
  const events = [];
  let entityOrdinal = 0;
  for (const row of fixture.webhookEntityMultiplicity || []) {
    for (let entity = 0; entity < row.entities; entity += 1) {
      entityOrdinal += 1;
      const recordType = entityOrdinal % 20 === 0
        ? "purchase_order"
        : entityOrdinal % 7 === 0 ? "transfer_order" : "sales_order";
      for (let version = 0; version < row.eventsPerEntity; version += 1) {
        events.push({
          recordType,
          id: `${runId}-${padded(entityOrdinal)}`,
          eventType: version ? "edit" : "create",
          lastModifiedDate: new Date(Date.UTC(2026, 7, 27, 12, entityOrdinal % 10, version)).toISOString(),
          lines: [{ line: 1, quantity: version + 1 }]
        });
      }
    }
  }
  return events;
}

async function enqueueWebhookReplay(events) {
  for (const payload of events) await enqueueNetSuiteOrderWebhook({ payload });
}

async function processWebhookReplaySerially(workerId) {
  let processed = 0;
  let maximumActive = 0;
  let active = 0;
  while (true) {
    const job = await claimNetSuiteOrderWebhook({ workerId, leaseMs: 30_000 });
    if (!job) break;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await completeNetSuiteOrderWebhook({
      id: job.id,
      leaseToken: job.leaseToken,
      result: { replay: true }
    });
    active -= 1;
    processed += 1;
  }
  return { processed, maximumActive };
}

async function queryPlans() {
  const dispatch = await query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT catalog.order_ref
       FROM dispatch_order_catalog_entries catalog
      WHERE catalog.eligible = true
        AND catalog.order_type = 'SO'
      ORDER BY catalog.activity_at DESC, lower(catalog.order_ref) DESC
      LIMIT 200`
  );
  const purchase = await query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT catalog.order_ref
       FROM scm_purchase_order_catalog_entries catalog
      WHERE catalog.eligible = true
        AND catalog.search_text ILIKE '%wl-pgob-2999%'
      ORDER BY catalog.activity_at DESC, lower(catalog.order_ref) DESC
      LIMIT 200`
  );
  return {
    dispatch: dispatch.rows[0]["QUERY PLAN"][0],
    purchaseOrderSearch: purchase.rows[0]["QUERY PLAN"][0]
  };
}

async function databaseStats() {
  await query("SELECT pg_stat_clear_snapshot()");
  const result = await query(
    `SELECT xact_commit, xact_rollback, blks_read, blks_hit,
            tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted
       FROM pg_stat_database
      WHERE datname = current_database()`
  );
  return Object.fromEntries(Object.entries(result.rows[0] || {}).map(([key, value]) => [key, Number(value || 0)]));
}

function subtractStats(after, before) {
  return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - (before[key] || 0)]));
}

async function run() {
  assertIsolated();
  const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
  validateAnonymizedWorkloadFixture(fixture);
  const replayPlan = buildAnonymizedWorkloadReplayPlan(fixture);
  const runId = `anonymous-${crypto.randomUUID()}`;
  const cpuBefore = process.cpuUsage();
  const statsBefore = await databaseStats();

  await query("TRUNCATE netsuite_order_webhook_attempts, netsuite_order_webhook_inbox RESTART IDENTITY CASCADE");
  await query("UPDATE netsuite_order_webhook_control SET paused = false, pause_reason = '', updated_at = now() WHERE singleton = true");
  const planCount = await seedPlansAndRetention();
  await replaceDispatchOrderCatalog({ orders: dispatchOrders(), source: "application-workload-gauntlet" });
  await replaceScmPurchaseOrderCatalog({ orders: purchaseOrders(), source: "application-workload-gauntlet" });
  const replayShape = await replayCountShape(fixture);

  const events = webhookEvents(fixture, runId);
  await enqueueWebhookReplay(events);
  const queueBeforeWorker = (await query(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'superseded')::int AS superseded
       FROM netsuite_order_webhook_inbox
      WHERE netsuite_order_id LIKE $1`,
    [`${runId}%`]
  )).rows[0];
  const workerPromise = processWebhookReplaySerially(`application-workload-gauntlet:${runId}`);

  const latency = [];
  latency.push(await samples("dispatch-initial-200", () => listDispatchOrderPool({ type: "SO", limit: 200 }), (result) => {
    if (result.orders.length !== 200) throw new Error("Dispatch initial page was not bounded to 200 cards.");
  }));
  latency.push(await samples("dispatch-indexed-search", () => listDispatchOrderPool({ type: "SO", search: "WL-SO-0999", limit: 200 }), (result) => {
    if (result.orders[0]?.id !== "WL-SO-0999" || result.orders[0]?.dispatchPlanned !== true) {
      throw new Error("Dispatch indexed search lost authoritative planned state.");
    }
  }));
  latency.push(await samples("po-initial-200", () => listScmPurchaseOrderCatalog({ limit: 200 }), (result) => {
    if (result.orders.length !== 200) throw new Error("PO initial page was not bounded to 200 cards.");
  }));
  latency.push(await samples("po-linked-reference-search", () => listScmPurchaseOrderCatalog({ search: "WL-PGOB-2999", limit: 200 }), (result) => {
    if (result.orders[0]?.id !== "WL-PO-2999") throw new Error("PO linked-reference search returned the wrong card.");
  }));
  latency.push(await samples("po-selected-detail", () => getScmPurchaseOrderCatalogOrder("WL-PO-2999"), (result) => {
    if (!result?.items?.length) throw new Error("PO detail hydration omitted lines.");
  }));

  const worker = await workerPromise;
  let retentionDeleted = 0;
  const retentionStartedAt = performance.now();
  while (true) {
    const batch = await pruneExpiredDispatchV2Checkpoints({ batchSize: 1_000 });
    retentionDeleted += batch.deleted;
    if (!batch.deleted) break;
  }
  const retained = (await query(
    `SELECT count(*) FILTER (WHERE history.checkpoint_kind <> 'recovery')::int AS regular,
            count(*) FILTER (WHERE history.checkpoint_kind = 'recovery' AND history.resolved_at IS NULL)::int AS recovery
       FROM dispatch_plan_snapshot_history history
       JOIN dispatch_plans plan ON plan.id = history.plan_id
      WHERE plan.note LIKE $1`,
    [`${PLAN_PREFIX}%`]
  )).rows[0];
  if (Number(retained.regular) !== PLAN_COUNT * 4 || Number(retained.recovery) !== PLAN_COUNT / 100) {
    throw new Error("Snapshot retention did not keep four future histories plus unresolved recovery evidence per policy.");
  }

  const plans = await queryPlans();
  const statsAfter = await databaseStats();
  const cpu = process.cpuUsage(cpuBefore);
  const artifact = {
    schemaVersion: "application-workload-gauntlet-v1",
    generatedAt: new Date().toISOString(),
    isolatedDatabase: true,
    sourceWindow: replayPlan.window,
    input: {
      planDates: planCount,
      dispatchCatalogOrders: ORDER_COUNT,
      purchaseOrderCatalogOrders: ORDER_COUNT,
      replayEvents: replayShape.events,
      replayEvidenceBytes: replayShape.evidenceBytes,
      webhookEvents: events.length,
      webhookEntities: replayPlan.optimized.minimumWebhookApplications
    },
    queue: {
      queuedAfterBurst: Number(queueBeforeWorker.queued || 0),
      supersededAfterBurst: Number(queueBeforeWorker.superseded || 0),
      processed: worker.processed,
      maximumActive: worker.maximumActive
    },
    retention: {
      deleted: retentionDeleted,
      retainedRegular: Number(retained.regular),
      retainedUnresolvedRecovery: Number(retained.recovery),
      wallMs: Number((performance.now() - retentionStartedAt).toFixed(3))
    },
    latency,
    slaMs: SLA_MS,
    queryPlans: plans,
    processCpuMs: {
      user: Number((cpu.user / 1_000).toFixed(3)),
      system: Number((cpu.system / 1_000).toFixed(3))
    },
    databaseStatsDelta: subtractStats(statsAfter, statsBefore),
    replayShapeWallMs: replayShape.wallMs,
    legacyWriteAmplification: replayPlan.legacy,
    optimizedWriteAmplification: replayPlan.optimized
  };

  if (artifact.queue.queuedAfterBurst !== 219
    || artifact.queue.supersededAfterBurst !== 111
    || artifact.queue.processed !== 219
    || artifact.queue.maximumActive !== 1) {
    throw new Error("The replayed webhook burst did not coalesce to 219 serial applications.");
  }
  await mkdir(new URL("../test-artifacts/", import.meta.url), { recursive: true });
  await writeFile(ARTIFACT_URL, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

try {
  await run();
} finally {
  await closeDb();
}
