import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const repository = 'src/special-stock-request-repository.js';
const service = 'src/special-stock-request-service.js';
const test = 'test/mbt/integration/special-po-warning.test.js';
const mutants = [
  ['restore-obsolete-so-comparison', repository, ').rows[0]?.local_adjusted_at) return false;', ').rows[0]?.missing_adjustment) return false;'],
  ['attempt-native-so-recovery', service, "prepared.salesOrderSource === 'manual_link' || Boolean(prepared.localAdjustedAt)", "prepared.salesOrderSource === 'manual_link'"],
  ['require-historical-so-description', repository, '!custom && !independentPurchase && !special.local_adjusted_at && await query', '!custom && !independentPurchase && await query'],
  ['ignore-issued-po-mismatch', repository, "orderKind === 'sales_order' && (await query(", "['sales_order', 'purchase_order'].includes(orderKind) && (await query("],
  ['ignore-unadjusted-so-mismatch', repository, ').rows[0]?.local_adjusted_at) return false;', ').rows[0]) return false;']
];
const results = [];
for (const [name, file, before, after] of mutants) {
  const root = '/tmp/special-po-warning-property';
  try {
    mkdirSync(root, { recursive: true });
    for (const part of ['src', 'public', 'package.json']) cpSync(part, `${root}/${part}`, { recursive: true });
    symlinkSync('/app/node_modules', `${root}/node_modules`, 'dir');
    mkdirSync(`${root}/test/mbt/integration`, { recursive: true });
    cpSync(test, `${root}/${test}`);
    const source = readFileSync(file, 'utf8');
    assert.equal(source.split(before).length, 2);
    writeFileSync(`${root}/${file}`, source.replace(before, after));
    const result = spawnSync('node', ['--test', '--test-name-pattern=property:', test],
      { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(`test-artifacts/property-mutant-${name}.log`, result.stdout + result.stderr);
    assert.ok([0, 1].includes(result.status));
    if (result.status === 1) assert.match(result.stdout, /not ok \d+ - property:/);
    results.push({ name, killedByPropertyAlone: result.status === 1 });
    console.log(JSON.stringify(results.at(-1)));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
writeFileSync('test-artifacts/property-mutations.json', JSON.stringify({ results,
  limits: 'The quantity property covers independence from historical SO content. Example-based integration tests cover native recovery, description linking, PO mismatch and unadjusted request safeguards.' }, null, 2));
