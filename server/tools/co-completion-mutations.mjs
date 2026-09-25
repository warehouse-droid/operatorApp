import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { closeDb, query } from '../src/db.js';
import { mutants } from '../test/support/co-completion-mutation-loader.mjs';

export async function runMutations(folder) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.match(process.env.DATABASE_URL || '', /\/mbt_test(?:[?#]|$)/u);
  const integration = ['test/mbt/unit/co-completion.test.js', 'test/mbt/integration/co-completion.test.js'];
  const properties = ['test/mbt/property/co-completion.property.test.js', 'test/mbt/property/co-completion-db.property.test.js'];
  const results = [];
  let lastStatus = null;
  const run = (name, files, mutant = '') => {
    const result = spawnSync(process.execPath, ['--experimental-loader', './test/support/co-completion-mutation-loader.mjs',
      '--test', '--test-concurrency=1', ...files], { encoding: 'utf8', maxBuffer: 20e6, env: { ...process.env, CO_COMPLETION_MUTANT: mutant } });
    writeFileSync(`${folder}/mutant-${name}.log`, result.stdout + result.stderr);
    assert.ifError(result.error);
    lastStatus = result.status;
    return result.status === 1 && result.stdout.includes('not ok');
  };
  for (const name of Object.keys(mutants)) {
    results.push({ name, killed: run(name, integration, name), propertiesKilled: run(name + '-property', properties, name) });
  }
  const definitions = {};
  for (const signature of ['dispatch_normalize_driver_co_execution_identity()', 'dispatch_completion_driver_order_kind(text,jsonb)']) {
    definitions[signature] = (await query('SELECT pg_get_functiondef($1::regprocedure) AS source', [signature])).rows[0].source;
  }
  const view = (await query("SELECT pg_get_viewdef('dispatch_effective_order_completion_events'::regclass,true) AS source")).rows[0].source;
  const sqlMutants = [
    ['dropCoNormalization', 'dispatch_normalize_driver_co_execution_identity()', "NEW.order_refs := jsonb_build_array(proof->>'coRef');", 'NULL;'],
    ['acceptWrongYard', 'dispatch_normalize_driver_co_execution_identity()', "lower(btrim(COALESCE(NEW.job_details->>'location',''))) <> lower(btrim(expected_location))", 'false'],
    ['coAsSalesOrder', 'dispatch_completion_driver_order_kind(text,jsonb)', "WHEN upper(btrim(raw_ref)) LIKE 'CO-%' THEN NULL", 'WHEN false THEN NULL']
  ];
  try {
    for (const [name, signature, from, to] of sqlMutants) {
      const original = definitions[signature];
      assert.equal(original.split(from).length, 2, name);
      try {
        await query(original.replace(from, to));
        results.push({ name, killed: run(name, integration), propertiesKilled: run(name + '-property', properties) });
      } finally { await query(original); }
    }
    try {
      await query('CREATE OR REPLACE VIEW dispatch_effective_order_completion_events AS SELECT * FROM dispatch_order_completion_events');
      results.push({ name: 'countVoidedEvidence', killed: run('countVoidedEvidence', integration), propertiesKilled: run('countVoidedEvidence-property', properties) });
    } finally { await query('CREATE OR REPLACE VIEW dispatch_effective_order_completion_events AS ' + view); }
    const restored = run('restored', [...integration, ...properties]);
    assert.equal(restored, false, 'Restored suite still fails');
    assert.equal(lastStatus, 0, 'Restored suite must exit successfully');
  } finally { await closeDb(); }
  writeFileSync(`${folder}/mutations.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  assert.ok(results.every(row => row.killed));
}
