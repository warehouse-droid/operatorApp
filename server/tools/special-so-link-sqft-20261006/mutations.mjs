import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const out = process.cwd() + '/test-artifacts/special-so-link-sqft-20261006';
const root = '/tmp/special-link-mutants';
rmSync(root, { recursive: true, force: true }); mkdirSync(root);
for (const folder of ['src', 'public', 'migrations']) cpSync(folder, root + '/' + folder, { recursive: true });
mkdirSync(root + '/test/mbt', { recursive: true });
for (const folder of ['unit', 'integration']) cpSync('test/mbt/' + folder, root + '/test/mbt/' + folder, { recursive: true });
cpSync('package.json', root + '/package.json');
symlinkSync('/app/node_modules', root + '/node_modules');
mkdirSync(root + '/test-artifacts', { recursive: true });
symlinkSync(out, root + '/test-artifacts/special-so-link-sqft-20261006');
const pricing = 'src/special-stock-pricing-domain.js', repository = 'src/special-stock-request-repository.js';
const browser = 'public/sales-special-stock-requests.js';
const texts = Object.fromEntries([pricing, repository, browser].map(file => [file, readFileSync(file, 'utf8')]));
const mutants = [
  ['SQFT-relabelled-PC', pricing, "const nativeSqft = basisUom === 'SQFT';", 'const nativeSqft = false;', 'pricing'],
  ['SQFT-conversion-allowed', pricing, 'if (nativeSqft && Number(conversionToPc) !== 1)', 'if (false)', 'pricing'],
  ['mapping-required-for-manual', repository, '{ requireMapping: !manual }', '{ requireMapping: true }', 'repository'],
  ['webhook-reblocks-manual', repository, "if (owner.rows[0]?.sales_order_source === 'manual_link') return false;", 'if (false) return false;', 'repository'],
  ['case-sensitive-SO-lookup', repository, 'lower(tranid)=lower($3)) OR (NOT $2::boolean', 'tranid=$3) OR (NOT $2::boolean', 'repository'],
  ['browser-SQFT-submitted-PC', browser, "uom: line.legacy || line.uom === 'SQFT' ? line.uom : 'PC'", "uom: line.legacy ? line.uom : 'PC'", 'browser']
];
const tests = { pricing: 'test/mbt/unit/special-sqft-draft.test.js', repository: 'test/mbt/integration/special-manual-so-link.test.js',
  browser: 'test/mbt/unit/special-manual-so-ui.browser.test.js' };
const results = [];
for (const [name, file, original, replacement, kind] of mutants) {
  assert.equal(texts[file].split(original).length, 2, name + ' must change exactly one location');
  writeFileSync(root + '/' + file, texts[file].replace(original, replacement));
  const args = ['--test', '--test-concurrency=1', tests[kind]];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 10000000 });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(out + '/mutation-' + name + '.log', log);
  assert.equal(result.status, 1, name + ' survived the behavior tests');
  let propertyKilled = null;
  if (kind === 'pricing' && name === 'SQFT-relabelled-PC') {
    const property = spawnSync(process.execPath, ['--test', '--test-name-pattern=property:', tests.pricing],
      { cwd: root, encoding: 'utf8', timeout: 30000 });
    writeFileSync(out + '/property-mutation-' + name + '.log', property.stdout + property.stderr);
    assert.equal(property.status, 1); propertyKilled = true;
  }
  results.push({ name, killed: true, propertyKilled });
  writeFileSync(root + '/' + file, texts[file]);
}
for (const [file, text] of Object.entries(texts)) assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),
  createHash('sha256').update(text).digest('hex'), 'Mounted source changed during mutation');
writeFileSync(out + '/mutations.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify({ mutationKills: results.length, results }));
