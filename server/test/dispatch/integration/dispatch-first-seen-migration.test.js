import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query, withTransaction } from "../../../src/db.js";

after(closeDb);

const migration = await readFile(new URL("../../../migrations/242_dispatch_order_first_seen.sql", import.meta.url), "utf8");
const sources = [
  { table: "sales_orders", type: "SO", entity: "sales_order" },
  { table: "purchase_orders", type: "PO", entity: "purchase_order" },
  { table: "transfer_orders", type: "TO", entity: "transfer_order" }
];

const businessTriggers = ["sor_header_changed", "trg_sales_fulfillment_dispatch_completion"];
const triggerModes = { O: "ENABLE", D: "DISABLE", R: "ENABLE REPLICA", A: "ENABLE ALWAYS" };

async function dropArrivalColumns() {
  for (const source of sources) {
    await query(`DROP TRIGGER IF EXISTS preserve_dispatch_order_first_seen_at ON ${source.table}`);
    await query(`ALTER TABLE ${source.table} DROP COLUMN IF EXISTS first_seen_at`);
  }
}

async function businessTriggerStates() {
  return (await query(
    `SELECT tgname, tgenabled FROM pg_trigger
      WHERE tgrelid='sales_orders'::regclass AND tgname=ANY($1::text[]) ORDER BY tgname`,
    [businessTriggers]
  )).rows;
}

async function businessProjections(ref) {
  return {
    queue: (await query("SELECT to_jsonb(item) AS value FROM sor_return_reconcile_queue item WHERE source_ref=$1", [ref])).rows,
    completion: (await query("SELECT to_jsonb(item) AS value FROM dispatch_order_completion_events item WHERE order_ref=$1 ORDER BY id", [ref])).rows
  };
}

async function installBusinessTriggerSentinels() {
  await query(`CREATE TEMP TABLE recent_arrival_trigger_effects (
    trigger_name text NOT NULL, header jsonb NOT NULL
  ) ON COMMIT DROP`);
  await query(`CREATE FUNCTION pg_temp.record_recent_arrival_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO recent_arrival_trigger_effects(trigger_name,header)
        VALUES(TG_NAME,CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END);
      RETURN NULL;
    END $$`);
  for (const name of businessTriggers) {
    await query(`DROP TRIGGER ${name} ON sales_orders`);
    await query(`CREATE TRIGGER ${name} AFTER INSERT OR UPDATE${name === "sor_header_changed" ? " OR DELETE" : ""}
      ON sales_orders FOR EACH ROW EXECUTE FUNCTION pg_temp.record_recent_arrival_trigger()`);
  }
}

async function sentinelNames(id, { businessOnly = true } = {}) {
  return (await query(
    `SELECT trigger_name FROM recent_arrival_trigger_effects
      WHERE (header->>'netsuite_id')::bigint=$1
        AND ($2::boolean=false OR trigger_name=ANY($3::text[])) ORDER BY trigger_name`,
    [id, businessOnly, businessTriggers]
  )).rows.map(row => row.trigger_name);
}

async function fulfilledSorFixture(id) {
  const ref = `SOR${id}`;
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,memo,fulfillment_status,fulfilled_at,synced_at)
    VALUES($1,$2,'fulfilled SOR migration fixture','fulfilled','2026-09-19T10:00:00Z','2026-09-20T10:00:00Z')`, [id, ref]);
  const projections = await businessProjections(ref);
  assert.equal(projections.queue.length, 1, "The actual SOR trigger must enqueue this fixture.");
  assert.equal(projections.completion.length, 1, "The actual fulfillment trigger must project this fixture.");
  return { id, ref, projections };
}

test("first-arrival migration recovers local evidence and preserves arrivals through edits and replay", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
      const baseId = 7_500_000_000 + crypto.randomInt(1_000_000);
      const fixtures = [];
      for (const source of sources) {
        await query(`DROP TRIGGER IF EXISTS preserve_dispatch_order_first_seen_at ON ${source.table}`);
        await query(`ALTER TABLE ${source.table} DROP COLUMN IF EXISTS first_seen_at`);
        for (let index = 0; index < 6; index++) {
          const id = baseId + index;
          const ref = `${source.type}-ARRIVAL-${suffix}-${index}`;
          await query(
            `INSERT INTO ${source.table} (
               netsuite_id, tranid, trandate, synced_at, status_updated_at, dispatch_parsed_at
             ) VALUES ($1, $2, '1900-01-01', $3, $4, $5)`,
            [id, ref, index === 5 ? null : "2026-09-29T10:00:00Z",
              index === 4 ? "2026-09-24T10:00:00Z" : null,
              index === 4 ? "2026-09-25T10:00:00Z" : null]
          );
          let expected = "2026-09-24T10:00:00.000Z";
          if (index === 0) {
            await query(
              `INSERT INTO delivery_audit_log (source, action, details, created_at)
               VALUES ('netsuite', 'netsuite.receiving_order.discover', $1::jsonb, '2026-09-20T10:00:00Z'),
                      ('netsuite', 'netsuite.order.discover', $2::jsonb, '2026-09-01T10:00:00Z')`,
              [JSON.stringify({ order: { netsuite_id: id, order_type: source.entity } }),
                JSON.stringify({ order: { netsuite_id: id, order_type: "incorrect_entity_type" } })]
            );
            expected = "2026-09-20T10:00:00.000Z";
          }
          if (index >= 1 && index <= 3) {
            const created = `2026-09-${20 + index}T10:00:00Z`;
            const fullOrder = index === 1
              ? { sourceTable: source.table, netsuiteId: id }
              : index === 2
                ? { sourceTable: source.table, raw: { netsuite_id: id } }
                : {};
            await query(
              `INSERT INTO dispatch_order_catalog_entries (
                 order_ref, order_type, sort_key, search_text, card, full_order, created_at
               ) VALUES ($1, $2, $1, '', '{}'::jsonb, $3::jsonb, $4)`,
              [index === 3 ? ref : `${ref}-OLD-REFERENCE`, source.type, JSON.stringify(fullOrder), created]
            );
            expected = `2026-09-${20 + index}T10:00:00.000Z`;
          }
          if (index === 5) expected = "1970-01-01T00:00:00.000Z";
          fixtures.push({ ...source, id, ref, expected });
        }
      }
      const sourceBytes = async fixture => (await query(
        `SELECT md5((to_jsonb(header)-'first_seen_at')::text) AS hash
           FROM ${fixture.table} header WHERE netsuite_id=$1`, [fixture.id]
      )).rows[0].hash;
      const before = [];
      for (const fixture of fixtures) before.push(await sourceBytes(fixture));
      await query(migration);
      for (const [index, fixture] of fixtures.entries()) {
        const row = (await query(
          `SELECT first_seen_at FROM ${fixture.table} WHERE netsuite_id=$1`, [fixture.id]
        )).rows[0];
        assert.equal(row.first_seen_at.toISOString(), fixture.expected, `${fixture.table} fixture ${fixture.ref}`);
        assert.equal(await sourceBytes(fixture), before[index], "Migration must preserve all other header fields.");
      }
      for (const source of sources) {
        const arrival = (await query("SELECT now() AS arrival")).rows[0].arrival;
        const id = baseId + 10;
        const row = (await query(
          `INSERT INTO ${source.table} (netsuite_id, tranid) VALUES ($1, $2)
           RETURNING first_seen_at`, [id, `${source.type}-NEW-ARRIVAL-${suffix}`]
        )).rows[0];
        assert.equal(row.first_seen_at.toISOString(), arrival.toISOString(), "New imports capture arrival automatically.");
        await query(
          `UPDATE ${source.table} SET first_seen_at=NULL, synced_at='2999-01-01' WHERE netsuite_id=$1`, [id]
        );
        await query(
          `INSERT INTO ${source.table} (netsuite_id, tranid, first_seen_at)
           VALUES ($1, $2, '2999-01-02')
           ON CONFLICT (netsuite_id) DO UPDATE SET first_seen_at=EXCLUDED.first_seen_at`,
          [id, `${source.type}-NEW-ARRIVAL-${suffix}`]
        );
        assert.equal((await query(
          `SELECT first_seen_at FROM ${source.table} WHERE netsuite_id=$1`, [id]
        )).rows[0].first_seen_at.toISOString(), arrival.toISOString(), "Edits and repeated upserts preserve the first arrival.");
      }
      await query(migration);
      for (const fixture of fixtures) {
        assert.equal((await query(
          `SELECT first_seen_at FROM ${fixture.table} WHERE netsuite_id=$1`, [fixture.id]
        )).rows[0].first_seen_at.toISOString(), fixture.expected, "Migration replay must preserve the original backfill.");
      }
    });
  } finally {
    await rollback.rollback();
  }
});

test("first-arrival metadata backfill suppresses only business projections and restores every trigger mode", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      for (const modes of [["O", "A"], ["R", "D"], ["A", "O"], ["D", "R"]]) {
        await withTransaction(async () => {
          await dropArrivalColumns();
          const fixture = await fulfilledSorFixture(7_600_000_000 + crypto.randomInt(1_000_000));
          await installBusinessTriggerSentinels();
          // Clear setup effects explicitly; later assertions observe migration effects only.
          const probeId = fixture.id + 2_000_000;
          await query(`INSERT INTO sales_orders(netsuite_id,tranid,fulfillment_status,fulfilled_at,synced_at)
            VALUES($1,$2,'fulfilled','2026-09-19T10:00:00Z','2026-09-20T10:00:00Z')`, [probeId, `SOR${probeId}`]);
          assert.deepEqual(await sentinelNames(probeId), businessTriggers);
          await query("DELETE FROM recent_arrival_trigger_effects");
          await query(`CREATE TRIGGER recent_arrival_unrelated AFTER UPDATE ON sales_orders
            FOR EACH ROW EXECUTE FUNCTION pg_temp.record_recent_arrival_trigger()`);
          for (const [index, name] of businessTriggers.entries()) {
            await query(`ALTER TABLE sales_orders ${triggerModes[modes[index]]} TRIGGER ${name}`);
          }
          const beforeStates = await businessTriggerStates();
          const beforeHeader = (await query("SELECT to_jsonb(item) AS value FROM sales_orders item WHERE netsuite_id=$1", [fixture.id])).rows[0].value;
          await query(migration);
          assert.deepEqual(await sentinelNames(fixture.id), [], "Metadata backfill must not execute either business trigger.");
          assert.deepEqual(await sentinelNames(probeId), [], "Every newly backfilled fulfilled SOR must avoid projection effects.");
          assert.deepEqual(await businessTriggerStates(), beforeStates, "Restore the exact original O/R/A/D states.");
          assert.deepEqual(await businessProjections(fixture.ref), fixture.projections, "Preserve real completion evidence and SOR queue bytes.");
          assert.deepEqual(await sentinelNames(fixture.id, { businessOnly: false }), ["recent_arrival_unrelated"], "An unrelated enabled trigger must still run.");
          const after = (await query("SELECT to_jsonb(item)-'first_seen_at' AS value,first_seen_at FROM sales_orders item WHERE netsuite_id=$1", [fixture.id])).rows[0];
          assert.deepEqual(after.value, beforeHeader, "Only arrival metadata may change.");
          assert.equal(after.first_seen_at.toISOString(), "2026-09-20T10:00:00.000Z");
          await query(migration);
          assert.deepEqual(await sentinelNames(fixture.id), [], "Replay must not run business projections.");
          assert.deepEqual(await businessTriggerStates(), beforeStates, "Replay must also preserve exact trigger modes.");
          assert.deepEqual(await sentinelNames(fixture.id, { businessOnly: false }), ["recent_arrival_unrelated"], "Replay must not rewrite an already populated arrival.");
          for (const role of ["origin", "replica"]) {
            await query("DELETE FROM recent_arrival_trigger_effects");
            await query(`SET LOCAL session_replication_role='${role}'`);
            await query("UPDATE sales_orders SET memo=$2 WHERE netsuite_id=$1", [fixture.id, `ordinary business edit under ${role}`]);
            const expected = businessTriggers.filter((_, index) => modes[index] === "A" || modes[index] === (role === "origin" ? "O" : "R"));
            assert.deepEqual(await sentinelNames(fixture.id), expected, "Business triggers must resume exactly their original origin/replica behavior.");
          }
          await query("SET LOCAL session_replication_role='origin'");
        }, { rollback: true });
      }
    });
  } finally {
    await rollback.rollback();
  }
});

test("failed first-arrival backfill rolls back trigger suspension, schema and source writes", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await dropArrivalColumns();
      const fixture = await fulfilledSorFixture(7_700_000_000 + crypto.randomInt(1_000_000));
      await query("INSERT INTO purchase_orders(netsuite_id,tranid,synced_at) VALUES($1,$2,'2026-09-20T10:00:00Z')", [fixture.id, `PO-FAIL-${fixture.id}`]);
      await installBusinessTriggerSentinels();
      await query("ALTER TABLE sales_orders ENABLE ALWAYS TRIGGER sor_header_changed");
      await query("ALTER TABLE sales_orders ENABLE REPLICA TRIGGER trg_sales_fulfillment_dispatch_completion");
      await query(`CREATE FUNCTION pg_temp.reject_recent_arrival_backfill() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'unrelated arrival fixture rejects backfill' USING ERRCODE='P0001'; END $$`);
      await query(`CREATE TRIGGER recent_arrival_failure BEFORE UPDATE ON sales_orders
        FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_recent_arrival_backfill()`);
      const beforeStates = await businessTriggerStates();
      const sourceState = async () => (await query(`SELECT 'SO' AS kind,to_jsonb(item) AS value FROM sales_orders item WHERE netsuite_id=$1
        UNION ALL SELECT 'PO',to_jsonb(item) FROM purchase_orders item WHERE netsuite_id=$1 ORDER BY kind`, [fixture.id])).rows;
      const before = await sourceState();
      await assert.rejects(withTransaction(async () => query(migration)), {
        code: "P0001", message: "unrelated arrival fixture rejects backfill"
      }, "An unrelated trigger must remain enabled and abort the backfill.");
      assert.deepEqual(await businessTriggerStates(), beforeStates, "Savepoint rollback restores the exact original trigger states.");
      assert.deepEqual(await sourceState(), before, "Failed migration must roll back all source writes and added columns.");
      assert.equal((await query(`SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_schema='public' AND table_name=ANY($1::text[]) AND column_name='first_seen_at'`, [sources.map(source => source.table)])).rows[0].count, 0);
      assert.deepEqual(await businessProjections(fixture.ref), fixture.projections, "Failed migration must preserve the actual business projections.");
      assert.deepEqual(await sentinelNames(fixture.id), [], "Failed migration must roll back any trigger effects.");
      await query("DROP TRIGGER recent_arrival_failure ON sales_orders");
      await query(migration);
      assert.deepEqual(await businessTriggerStates(), beforeStates, "A later successful retry must preserve the same original modes.");
      assert.deepEqual(await sentinelNames(fixture.id), [], "Successful retry must suppress business projections.");
      await query("UPDATE sales_orders SET memo='after successful retry' WHERE netsuite_id=$1", [fixture.id]);
      assert.deepEqual(await sentinelNames(fixture.id), ["sor_header_changed"], "The originally ALWAYS trigger must work after failure and retry.");
    });
  } finally {
    await rollback.rollback();
  }
});
