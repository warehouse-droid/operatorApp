"""Exercise the exact release migration/hash guard in a disposable database.

Run: python3 tools/dispatch-recent-cards-migration-guard.py [--source PATH]
The existing isolated runner creates/removes the database; no live DB is used.
The fixture includes 16,000 headers and 900 bulky catalog records; fresh
backfill must complete under the migration's unchanged 60-second budget.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/dispatch-recent-cards'

CHECK = r'''
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { query, withTransaction, closeDb } from "/app/src/db.js";

const input = JSON.parse(readFileSync("/app/test-artifacts/migration-guard-input.json", "utf8"));
const result = { passed: false, migration: input.migration, migrationSha256: input.migrationSha256,
  businessHashSqlSha256: input.businessHashSqlSha256, guardSqlSha256: input.guardSqlSha256,
  isolated: true, excludedMetadata: ["first_seen_at"] };
let failure;
try {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  result.database = (await query("SELECT current_database() AS database")).rows[0].database;
  assert.ok(["mbt_test", "mbt_verify"].includes(result.database));
  assert.equal((await query("SELECT count(*)::int AS count FROM schema_migrations WHERE filename=$1", [input.migration])).rows[0].count, 1);
  const syntax = spawnSync(process.execPath, ["--check", "tools/dispatch-recent-cards-live.mjs"], { encoding: "utf8" });
  writeFileSync("/app/test-artifacts/live-checker-syntax.log", (syntax.stdout || "") + (syntax.stderr || ""));
  assert.equal(syntax.error, undefined);
  assert.equal(syntax.status, 0);
  result.liveCheckerSyntax = { exitCode: syntax.status };

  const suffix = randomUUID().slice(0, 8);
  const fixtureId = 8_600_000_000 + randomInt(1_000_000);
  const scaleBase = fixtureId + 2_000_000;
  const scaleSources = [
    { table: "sales_orders", type: "SO", entity: "sales_order", count: 15000 },
    { table: "purchase_orders", type: "PO", entity: "purchase_order", count: 500 },
    { table: "transfer_orders", type: "TO", entity: "transfer_order", count: 500 }
  ];
  await withTransaction(async () => {
    for (const [table, type] of [["sales_orders", "SO"], ["purchase_orders", "PO"], ["transfer_orders", "TO"]]) {
      await query(`INSERT INTO ${table}(netsuite_id,tranid,memo,synced_at)
        VALUES($1,$2,'migration guard fixture','2026-09-01T10:00:00Z')`, [fixtureId, `${type}-GUARD-${suffix}`]);
    }
    await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_name,quantity) VALUES($1,1,'guard sales cargo',1)", [fixtureId]);
    await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_name,quantity) VALUES($1,1,'guard purchase cargo',1)", [fixtureId]);
    await query("INSERT INTO transfer_order_lines(line_stage,transfer_order_id,line_id,item_name,quantity) VALUES('outbound',$1,1,'guard transfer cargo',1)", [fixtureId]);
    const planId = (await query("INSERT INTO dispatch_plans(plan_date,status,note) VALUES('2096-12-13','draft','migration guard fixture') RETURNING id")).rows[0].id;
    const trucks = [{ id: `truck-${suffix}`, plate: "GUARD", loads: [{ id: `load-${suffix}`, name: "Guard load", orders: [] }] }];
    await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks) VALUES($1,'[]'::jsonb,$2::jsonb)", [planId, JSON.stringify(trucks)]);
    await query("INSERT INTO dispatch_plan_load_assignments(plan_id,plan_date,load_id,load_name) VALUES($1,'2096-12-13',$2,'Guard load')", [planId, `load-${suffix}`]);
    for (const [index, source] of scaleSources.entries()) {
      const base = scaleBase + index * 20000;
      await query(`INSERT INTO ${source.table}(netsuite_id,tranid,memo,synced_at)
        SELECT $1::bigint+n,CASE WHEN $4='SO' AND n<147 THEN 'SOR'||($1::bigint+n)::text ELSE $2||n::text END,'production-scale guard fixture',
          CASE WHEN n=$3::int-1 THEN NULL ELSE '2026-09-20T10:00:00Z'::timestamptz END
        FROM generate_series(0,$3::int-1) fixture(n)`, [base, `${source.type}-SCALE-${suffix}-`, source.count, source.type]);
      if (source.type === "SO") await query(`UPDATE sales_orders SET fulfillment_status='fulfilled',fulfilled_at='2026-09-21T10:00:00Z'
        WHERE netsuite_id >= $1::bigint AND netsuite_id < $1::bigint+5150`, [base]);
      await query(`INSERT INTO dispatch_order_catalog_entries
          (order_ref,order_type,sort_key,search_text,card,full_order,created_at)
        SELECT (CASE WHEN $3='SO' AND n<147 THEN 'SOR'||($1::bigint+n)::text ELSE $2||n::text END)
            || CASE WHEN n%4=3 THEN '' ELSE '-OLD-REFERENCE' END,
          $3,$2||n::text,'migration performance fixture','{}'::jsonb,
          jsonb_build_object('cargo',(SELECT jsonb_agg(jsonb_build_object(
            'sku','GUARD-'||n::text||'-'||item::text,
            'description',repeat(md5(n::text||'/'||item::text),8)))
            FROM generate_series(1,120) cargo(item)))
          || CASE n%4
            WHEN 0 THEN jsonb_build_object('sourceTable',$4::text,'sourceRecordId',($1::bigint+n)::text)
            WHEN 1 THEN jsonb_build_object('sourceTable',$4::text,'netsuiteId',$1::bigint+n)
            WHEN 2 THEN jsonb_build_object('sourceTable',$4::text,'raw',jsonb_build_object('netsuite_id',$1::bigint+n))
            ELSE '{}'::jsonb END,
          '2026-09-10T10:00:00Z'::timestamptz
        FROM generate_series(0,299) fixture(n)`, [base, `${source.type}-SCALE-${suffix}-`, source.type, source.table]);
      await query(`INSERT INTO delivery_audit_log(source,action,details,created_at)
        SELECT 'netsuite','netsuite.order.discover',jsonb_build_object('order',jsonb_build_object(
          'netsuite_id',$1::bigint+n,'order_type',$2::text)),
          CASE WHEN n=0 THEN '2026-09-05T10:00:00Z'::timestamptz ELSE '2026-09-25T10:00:00Z'::timestamptz END
        FROM generate_series(0,$3::int-2) fixture(n)`, [base, source.entity, source.count]);
    }
  });
  result.productionScale = { headers: scaleSources.reduce((total, source) => total + source.count, 0),
    catalogRecords: 900, discoveryRecords: 15997, fulfilledSalesHeaders: 5150, sorSalesHeaders: 147, statementBudgetMs: 60000,
    catalogPayloadBytes: (await query("SELECT avg(octet_length(full_order::text))::int AS average,max(octet_length(full_order::text))::int AS maximum FROM dispatch_order_catalog_entries WHERE search_text='migration performance fixture'")).rows[0] };
  assert.ok(result.productionScale.catalogPayloadBytes.average > 30000);
  const hash = async () => (await query(input.businessHashSql)).rows[0].hashes;
  const triggerState = async () => (await query(`SELECT relation.relname AS table_name,trigger.tgname AS trigger_name,
      trigger.tgenabled AS mode,pg_get_triggerdef(trigger.oid) AS definition
    FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public' AND relation.relname IN ('sales_orders','purchase_orders','transfer_orders')
      AND trigger.tgname <> 'preserve_dispatch_order_first_seen_at'
    ORDER BY relation.relname,trigger.tgname`)).rows;
  const originalTriggers = await triggerState();
  result.beforeTriggers = originalTriggers;
  const original = await hash();
  assert.equal(Object.keys(original).length, 11);
  for (const [table, row] of Object.entries(original)) assert.ok(Number(row.rows) > 0, `${table} fixture was not populated`);
  await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`schema-migration:${input.migration}`]);
    await query("CREATE TEMP TABLE dispatch_recent_cards_business_before ON COMMIT DROP AS " + input.businessHashSql);
    result.beforeHashes = (await query("SELECT hashes FROM dispatch_recent_cards_business_before")).rows[0].hashes;
    await query(input.migrationSql);
    await query(input.guardSql);
    result.afterHashes = await hash();
    assert.deepEqual(result.afterHashes, result.beforeHashes);
  }, { rollback: true });
  assert.deepEqual(await triggerState(), originalTriggers);
  result.positive = { passed: true, tablesVerified: 11, migrationReplay: true };

  const performanceStarted = performance.now();
  await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    for (const source of scaleSources) {
      await query(`DROP TRIGGER IF EXISTS preserve_dispatch_order_first_seen_at ON ${source.table}`);
      await query(`ALTER TABLE ${source.table} DROP COLUMN first_seen_at`);
    }
    await query("CREATE TEMP TABLE dispatch_recent_cards_business_before ON COMMIT DROP AS " + input.businessHashSql);
    const migrationStarted = performance.now();
    await query(input.migrationSql);
    result.productionScale.migrationMs = Math.round(performance.now() - migrationStarted);
    await query(input.guardSql);
    assert.deepEqual(await hash(), original, "Fresh production-scale backfill must preserve all eleven business/side-effect tables");
    assert.deepEqual(await triggerState(), originalTriggers, "Fresh backfill must restore original trigger definitions and firing modes");
    for (const [index, source] of scaleSources.entries()) {
      const base = scaleBase + index * 20000;
      const checks = (await query(`SELECT netsuite_id::text,first_seen_at FROM ${source.table}
        WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id`, [[base,base+1,base+2,base+3,base+350,base+source.count-1]])).rows;
      assert.equal(checks.length, 6);
      assert.deepEqual(checks.map(row => row.first_seen_at.toISOString()), [
        "2026-09-05T10:00:00.000Z", "2026-09-10T10:00:00.000Z", "2026-09-10T10:00:00.000Z",
        "2026-09-10T10:00:00.000Z", "2026-09-20T10:00:00.000Z", "1970-01-01T00:00:00.000Z"
      ], `${source.table}: discovery, all catalog aliases, typed ref, header fallback and unknown arrival`);
    }
  }, { rollback: true });
  result.productionScale.guardedTransactionMs = Math.round(performance.now() - performanceStarted);
  assert.ok(result.productionScale.migrationMs < result.productionScale.statementBudgetMs);
  result.productionScale.passed = true;

  const businessTriggers = ["sor_header_changed", "trg_sales_fulfillment_dispatch_completion"];
  assert.equal(originalTriggers.filter(row => row.table_name === "sales_orders" && businessTriggers.includes(row.trigger_name)).length, 2);
  result.triggerModes = [];
  for (const [mode, action] of [["O", "ENABLE"], ["D", "DISABLE"], ["R", "ENABLE REPLICA"], ["A", "ENABLE ALWAYS"]]) {
    await withTransaction(async () => {
      for (const name of businessTriggers) await query(`ALTER TABLE sales_orders ${action} TRIGGER ${name}`);
      const expected = await triggerState();
      await query("DROP TRIGGER preserve_dispatch_order_first_seen_at ON sales_orders; ALTER TABLE sales_orders DROP COLUMN first_seen_at");
      await query("CREATE TEMP TABLE dispatch_recent_cards_business_before ON COMMIT DROP AS " + input.businessHashSql);
      await query(input.migrationSql);
      await query(input.guardSql);
      assert.deepEqual(await triggerState(), expected, `${mode} trigger mode must be restored`);
      assert.deepEqual(await hash(), original, `${mode} trigger mode must not change business or projection data`);
    }, { rollback: true });
    result.triggerModes.push({ mode, restored: true, sideEffectsUnchanged: true });
  }
  await withTransaction(async () => {
    await query("DROP TRIGGER sor_header_changed ON sales_orders");
    const expected = await triggerState();
    await query(input.migrationSql);
    assert.deepEqual(await triggerState(), expected, "A missing optional business trigger must remain missing");
  }, { rollback: true });
  result.missingOptionalTriggerPreserved = true;

  const interruptionPoint = "    EXECUTE format('ANALYZE %I (first_seen_at)', source.table_name);";
  assert.ok(input.migrationSql.includes(interruptionPoint), "The interruption fixture must occur after trigger suspension");
  result.interruptionRollback = [];
  for (const [name, injection, expectedCode] of [
    ["error", "    RAISE EXCEPTION 'forced migration interruption';\n", "P0001"],
    ["cancellation", "    PERFORM pg_sleep(1);\n", "57014"]
  ]) {
    let rejected;
    let interrupted = input.migrationSql.replace(interruptionPoint, injection + interruptionPoint);
    if (name === "cancellation") interrupted = interrupted.replace("SET LOCAL statement_timeout = '60s';", "SET LOCAL statement_timeout = '100ms';");
    try {
      await withTransaction(async () => {
        await query("DROP TRIGGER preserve_dispatch_order_first_seen_at ON sales_orders; ALTER TABLE sales_orders DROP COLUMN first_seen_at");
        await query(interrupted);
      });
    } catch (error) { rejected = error; }
    assert.equal(rejected?.code, expectedCode, `${name} must interrupt the real suspension transaction`);
    assert.deepEqual(await triggerState(), originalTriggers, `${name} must roll trigger state back`);
    assert.deepEqual(await hash(), original, `${name} must roll business and side-effect data back`);
    assert.equal((await query("SELECT count(*)::int AS count FROM sales_orders WHERE first_seen_at IS NULL")).rows[0].count, 0);
    result.interruptionRollback.push({ name, sqlState: rejected.code, triggersRestored: true, sideEffectsUnchanged: true });
  }
  result.afterTriggers = await triggerState();
  result.sideEffects = { before: { completions: original.dispatch_order_completion_events, sorQueue: original.sor_return_reconcile_queue },
    after: { completions: (await hash()).dispatch_order_completion_events, sorQueue: (await hash()).sor_return_reconcile_queue } };

  let rejected;
  try {
    await withTransaction(async () => {
      await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await query("CREATE TEMP TABLE dispatch_recent_cards_business_before ON COMMIT DROP AS " + input.businessHashSql);
      await query(input.migrationSql);
      await query("UPDATE sales_orders SET memo='negative business mutation' WHERE netsuite_id=$1", [fixtureId]);
      await query(input.guardSql);
    });
  } catch (error) { rejected = error; }
  assert.equal(rejected?.code, "P0001", "The exact SQL guard must reject a business mutation");
  assert.match(rejected.message, /changed existing order, line, saved plan or load data/);
  assert.equal((await query("SELECT memo FROM sales_orders WHERE netsuite_id=$1", [fixtureId])).rows[0].memo, "migration guard fixture");
  assert.deepEqual(await hash(), original, "The rejected mutant transaction must roll back every business write");
  result.negative = { rejected: true, sqlState: rejected.code, businessWriteRolledBack: true, mutantsKilled: 1 };
  result.passed = true;
} catch (error) {
  failure = error;
  result.error = { name: error.name, message: error.message, code: error.code };
} finally {
  try { await closeDb(); } catch (error) {
    failure ||= error;
    result.passed = false;
    result.closeError = error.message;
  }
  writeFileSync("/app/test-artifacts/guard-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
if (failure) throw failure;
'''


def sha(value):
    return hashlib.sha256(value).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=OUT / 'candidate' if (OUT / 'candidate').exists() else SERVER)
    source = parser.parse_args().source.resolve()
    os.umask(0o077)
    OUT.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='migration-guard-', dir=OUT))
    result = {'passed': False, 'source': str(source), 'artifacts': str(directory),
              'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    print(json.dumps({'artifacts': str(directory)}), flush=True)
    try:
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location('dispatch_recent_release_guard', SERVER / 'tools/dispatch-recent-cards-release.py')
        release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(release)
        migration = (source / release.MIGRATION_PATH).read_bytes()
        guard = release.migration_business_guard_sql()
        payload = {'migration': release.MIGRATION, 'migrationSql': migration.decode('utf8'),
                   'migrationSha256': sha(migration), 'businessHashSql': release.BUSINESS_HASH_SQL,
                   'businessHashSqlSha256': sha(release.BUSINESS_HASH_SQL.encode()),
                   'guardSql': guard, 'guardSqlSha256': sha(guard.encode())}
        result['testedHashes'] = {name: value for name, value in payload.items() if name.endswith('Sha256')}
        (directory / 'migration-guard-input.json').write_text(json.dumps(payload, indent=2) + '\n')
        (directory / 'migration-guard-check.mjs').write_text(CHECK)
        overlay = directory / 'source'
        overlay.mkdir()
        for folder in ('src', 'public', 'migrations'):
            (overlay / folder).symlink_to(source / folder, target_is_directory=True)
        for folder in ('test', 'tools', 'contracts'):
            (overlay / folder).symlink_to(SERVER / folder, target_is_directory=True)
        for file in source.glob('*'):
            if file.is_file() and file.suffix in ('.json', '.js', '.mjs'):
                (overlay / file.name).symlink_to(file)
        check = os.path.relpath(directory, SERVER / 'test-artifacts/mbt-bin-planning/checks')
        command = ['sudo', '-n', 'env', f'BIN_PLANNING_SOURCE_ROOT={overlay}', f'BIN_PLANNING_CHECK={check}',
                   'bash', str(SERVER / 'tools/bin-planning-test.sh'), 'node', '/app/test-artifacts/migration-guard-check.mjs']
        with (directory / 'run.log').open('wb') as log:
            completed = subprocess.run(command, cwd=SERVER, stdout=log, stderr=subprocess.STDOUT)
        result['exitCode'] = completed.returncode
        if (directory / 'guard-result.json').exists():
            result['guard'] = json.loads((directory / 'guard-result.json').read_text())
        completed.check_returncode()
        assert result['guard']['passed'] is True
        assert sha((source / release.MIGRATION_PATH).read_bytes()) == payload['migrationSha256'], 'Migration source changed during validation'
        assert release.migration_business_guard_sql() == guard, 'Release guard changed during validation'
        result['passed'] = True
    except Exception as error:
        result['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (directory / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
