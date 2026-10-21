import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp('/tmp/posting-packs-mutants-');
const artifact = 'test-artifacts/operator-posting-pack-quantities/mutations';
const packs = [
  ['wrong-layer-column', 'packs', "['layers', 'layer', 'custcol_lyr']", "['layers', 'layer', 'custcol_plt']"],
  ['cumulative-counts', 'packs', 'Math.max(packed - completed, 0)', 'Math.max(packed + completed, 0)'],
  ['lost-allocation', 'packs', 'packCount(left[key] + right[key])', 'packCount(left[key])'],
  ['copied-unused-columns', 'packs', 'return count === undefined ? [] : [[field, count]];',
    'return count === undefined || count === 0 ? [] : [[field, count]];'],
  ['descriptive-field-gate', 'adapter', 'const id = assertRecordIdentity(step, record);',
    "const id = assertRecordIdentity(step, record);\n  if (record.item.items[0].custcol_lyr !== step.payload.item.items[0].custcol_lyr) { throw mismatch('Descriptive LYR mismatch'); }"]
];
const yards = [
  ['foreign-yard-lines', 'customer-pickup-yard-scope', '=== yard)', '!== yard)'],
  ['wrong-canonical-yard', 'customer-pickup-yard-scope', 'pickup_location_id: yard,', 'pickup_location_id: 1,'],
  ['unscoped-pickup-target', 'targets', 'root = scopeCustomerPickupOrderYard(root, yard);',
    'root = { ...root, pickup_location_id: Number(yard) };']
];
const scopeGuards = [
  ['unsupported-location-allowed', 'customer-pickup-yard-scope', 'if (!yard) {', 'if (false) {'],
  ['empty-yard-allowed', 'customer-pickup-yard-scope',
    'if (yard === null || !customerPickupOrderYards(order).includes(yard)) { throw operatorYardForbidden(); }',
    'if (false) { throw operatorYardForbidden(); }']
];
const database = [
  ['foreign-line-confirmation', 'operator-yard-authorization',
    'if (ids.some((/** @type {any} */ id) => !own.has(String(id)))) { throw operatorYardForbidden(); }',
    'if (false) { throw operatorYardForbidden(); }'],
  ['clear-other-yard', 'delivery-repository', 'AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))',
    'AND ($2::bigint[] IS NULL OR true)'],
  ['load-erases-other-draft', 'delivery-repository', 'AND id = ANY($2::bigint[])\n        AND (',
    'AND ($2::bigint[] IS NULL OR true)\n        AND ('],
  ['unscoped-finalizer', 'finalizer', 'locationId: command.canonicalLocationId ?? null,', 'locationId: null,'],
  ['unscoped-preflight', 'controller', 'locationId: resolution.canonicalLocationId,', 'locationId: null,'],
  ['foreign-confirmation-summary', 'customer-pickup-yard-scope', 'deliveryLoadConfirmation(scoped)', 'deliveryLoadConfirmation(order)']
];
const ui = [
  ['pickup-refresh-uses-delivery', 'operator-ui', 'return isCustomerPickupMode()\n', 'return false\n'],
  ['delivery-refresh-uses-pickup', 'operator-ui', 'return isCustomerPickupMode()\n', 'return true\n']
];
const modulePath = name => ['packs', 'adapter', 'targets', 'finalizer', 'controller'].includes(name)
  ? `src/operator-netsuite-posting-${name}.js` : name === 'operator-ui' ? 'public/operator.js' : `src/${name}.js`;
const packTest = 'test/mbt/unit/operator-posting-pack-quantities.test.js';
const yardTest = 'test/mbt/unit/customer-pickup-yard-scope.test.js';
const databaseTest = 'test/mbt/integration/customer-pickup-yard-scope.test.js';
const uiTest = 'test/mbt/unit/customer-pickup-yard-ui.test.js';
await mkdir(artifact, { recursive: true });
try {
  await cp('src', `${directory}/src`, { recursive: true });
  await cp('public', `${directory}/public`, { recursive: true });
  await cp('contracts', `${directory}/contracts`, { recursive: true });
  for (const name of [packTest, yardTest, databaseTest, uiTest, 'public/operator.js', 'public/operator.html', 'public/service-worker.js',
    'test/support/operator-ui-enhancements-fixture.mjs']) {
    await cp(name, `${directory}/${name}`, { recursive: true });
  }
  await cp('package.json', `${directory}/package.json`);
  await symlink('/app/node_modules', `${directory}/node_modules`);
  const names = [...new Set([...packs, ...yards, ...scopeGuards, ...database, ...ui].map(mutation => mutation[1]))];
  const originals = Object.fromEntries(await Promise.all(names.map(async name =>
    [name, await readFile(`${directory}/${modulePath(name)}`, 'utf8')])));
  const results = [];
  const runs = [[packs, packTest, false], [packs, packTest, true], [yards, yardTest, false], [yards, yardTest, true],
    [scopeGuards, yardTest, false], [database, databaseTest, false], [ui, uiTest, false]];
  for (const [mutations, testFile, propertyOnly] of runs) {
    for (const [name, moduleName, before, after] of mutations) {
      const original = originals[moduleName];
      assert.equal(original.split(before).length, 2, `Unique mutation anchor: ${name}`);
      const path = `${directory}/${modulePath(moduleName)}`;
      await writeFile(path, original.replace(before, after));
      const args = ['--test', '--test-concurrency=1'];
      if (propertyOnly) { args.push('--test-name-pattern=property'); }
      args.push(testFile);
      const run = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 45000 });
      const log = (run.stdout || '') + (run.stderr || '');
      await writeFile(`${artifact}/${propertyOnly ? 'property-' : ''}${name}.log`, log);
      await writeFile(path, original);
      assert.ok(run.status !== 0 && /not ok/u.test(log) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(log),
        `Mutation survived or infrastructure failed: ${name}`);
      results.push({ name, propertyOnly, testFile, killed: true });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  await writeFile(`${artifact}/results.json`, JSON.stringify(results, null, 2) + '\n');
} finally { await rm(directory, { recursive: true, force: true }); }
