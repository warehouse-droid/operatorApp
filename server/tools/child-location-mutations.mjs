import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const unit = ['test/mbt/unit/child-location-fulfillment.test.js', 'test/mbt/unit/child-location-parts-service.test.js'];
const property = ['test/mbt/property/child-location-fulfillment.property.test.js'];
const http = ['test/mbt/integration/child-location-http.test.js'];
const mutants = [
  ['missing-parent-resolution', 'src/outbound-location-domain.js', 'id = locationId(row.parent);', 'id = null;'],
  ['inactive-child-admitted', 'src/outbound-location-domain.js', "/^(?:T|TRUE|1)$/i.test(String(row.isinactive ?? false))", 'false'],
  ['wrong-location-partition', 'src/item-fulfillment-parts-domain.js', 'id(item.location) === locationId', 'id(item.location) !== locationId'],
  ['disabled-line-selected', 'src/item-fulfillment-parts-domain.js', 'item.itemReceive !== false && ', ''],
  ['ambiguous-error-splits', 'src/item-fulfillment-parts-domain.js', ' || error.ambiguous === true', ''],
  ['unverified-part-recovery', 'src/item-fulfillment-parts-service.js', 'adapter.verify(target, record);', '/* verification deliberately removed */'],
  ['duplicate-part-claim', 'src/item-fulfillment-parts-service.js', "if (!claimed.fresh) {throw uncertain('The previous IF part attempt needs verification before retrying.');}", '/* deliberately ignore attempt fence */'],
  ['foreign-inventory-ignored', 'src/outbound-location-domain.js', '(child.lines || []).filter(activeInventoryLine)', '[]']
];
const root = mkdtempSync(join(tmpdir(), 'child-location-mutants-'));
const results = [];
try {
  for (const folder of ['src','test']) { cpSync(folder, join(root, folder), { recursive: true }); }
  for (const name of ['node_modules','public','migrations','contracts','package.json','test-artifacts']) { symlinkSync(`/app/${name}`, join(root, name)); }
  function run(files) {
    const result = spawnSync(process.execPath, ['--test','--test-concurrency=1', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { status: result.status, output: result.stdout + result.stderr };
  }
  assert.equal(run([...unit, ...property]).status, 0, 'The unmodified mutation baseline must pass');
  for (const [index, [name,file,from,to]] of mutants.entries()) {
    const path = join(root, file), original = readFileSync(path, 'utf8');
    assert.ok(original.includes(from), `Missing mutation anchor: ${name}`);
    writeFileSync(path, original.replaceAll(from, to));
    try {
      const suites = index < 5 ? [['unit',unit],['property',property]] : [['unit',unit]];
      if (index === 0 || index === 7) { suites.push(['http',http]); }
      for (const [layer, files] of suites) {
        const result = run(files);
        writeFileSync(`test-artifacts/child-locations/mutation-${name}-${layer}.log`, result.output);
        assert.notEqual(result.status, 0, `Surviving mutant: ${name}/${layer}`);
        assert.match(result.output, /(?:AssertionError|ERR_ASSERTION|Property failed after)/, `Mutant must fail behavior: ${name}/${layer}`);
        results.push({ name, layer, killed: true });
      }
    } finally { writeFileSync(path, original); }
  }
  const restored = run([...unit, ...property]);
  assert.equal(restored.status, 0, restored.output);
  writeFileSync('test-artifacts/child-locations/mutations.json', JSON.stringify(results,null,2));
  console.log(JSON.stringify({ killed: results.length, units: 8, properties: 5, http: 2, restored: true }));
} finally { rmSync(root, { recursive: true, force: true }); }
