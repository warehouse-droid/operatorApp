import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const propertyOnly = process.argv.includes('property');
const artifact = `/app/test-artifacts/operator-to-yard-flow/mutations${propertyOnly ? '-property' : ''}`;
await mkdir(artifact, { recursive: true });
const temporary = await mkdtemp('/tmp/to-yard-mutants-');
const mutations = [
  ['receipt-gate', 'src/transfer-order-posting-domain.js', "return 'waiting_receipt';", 'return null;'],
  ['fulfillment-order', 'src/transfer-order-posting-domain.js', "if(job.transaction_type==='IR' && loads.some", "if(job.transaction_type==='NEVER' && loads.some"],
  ['dispatch-scope', 'src/transfer-order-posting-domain.js', "&& ['planId','loadId','planDate'].every(key=>String(job.snapshot[key] ?? '')===String(other.snapshot[key] ?? ''));", ';'],
  ['receiving-capacity', 'src/transfer-order-posting-repository.js', 'receiving_unavailable_qty:total-quantity+(Number(line.receiving_completed_qty) || 0)', 'receiving_unavailable_qty:Number(line.receiving_completed_qty) || 0'],
  ['remote-receipt-overwrite', 'src/transfer-order-posting-repository.js', 'receiving_completed_qty:physicalOnly?saved:Math.max(Number(line.netsuite_received_qty)||0,saved)', 'receiving_completed_qty:Math.max(Number(line.netsuite_received_qty)||0,saved)'],
  ['remote-load-overwrite', 'src/server.js', 'fulfilled_pallet_qty = CASE WHEN $17::boolean THEN $19 ELSE fulfilled_pallet_qty END,', 'loaded_qty = CASE WHEN $17::boolean THEN $18 ELSE loaded_qty END, fulfilled_pallet_qty = CASE WHEN $17::boolean THEN $19 ELSE fulfilled_pallet_qty END,'],
  ['receiving-refresh', 'src/order-sync-repository.js', 'clauses.push("to_location_id IS NOT NULL");', 'clauses.push("receiving_status IS NOT NULL");'],
  ['waiting-status-schema', 'migrations/279_operator_to_yard_flow.sql', "'waiting_load','waiting_receipt','waiting_driver'", "'waiting_load','waiting_driver'"]
];
try {
  await cp('/app/src', `${temporary}/src`, { recursive: true });
  await cp('/app/test', `${temporary}/test`, { recursive: true });
  await cp('/app/migrations', `${temporary}/migrations`, { recursive: true });
  await cp('/app/package.json', `${temporary}/package.json`);
  for (const directory of ['node_modules', 'public', 'contracts']) { await symlink(`/app/${directory}`, `${temporary}/${directory}`); }
  const results = [];
  for (const [name, file, before, after] of mutations) {
    if(propertyOnly && ['remote-load-overwrite','remote-receipt-overwrite','receiving-refresh','waiting-status-schema'].includes(name)){continue;}
    const path = `${temporary}/${file}`, original = await readFile(path, 'utf8');
    assert.equal(original.split(before).length, 2, `Mutation anchor must be unique: ${name}`);
    await writeFile(path, original.replace(before, after));
    const selected = propertyOnly ? ['test/mbt/property/operator-to-yard-flow.property.test.js']
      : ['test/mbt/integration/operator-to-yard-flow.test.js', 'test/mbt/property/operator-to-yard-flow.property.test.js'];
    const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...selected],
    { cwd: temporary, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(path, original);
    const output = (run.stdout || '') + (run.stderr || '');
    await writeFile(`${artifact}/${name}.log`, output);
    assert.ok(run.status !== 0 && /not ok/u.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output), `Mutation survived or failed infrastructure: ${name}`);
    results.push({ name, killed: true });
    console.log(`Killed ${name}`);
  }
  await writeFile(`${artifact}/results.json`, JSON.stringify(results, null, 2) + '\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
