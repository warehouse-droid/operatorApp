import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, out, testFiles } from './checks.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const root = mkdtempSync(join(tmpdir(), 'pallet-search-mutants-'));
const results = [];
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Mutation must have one target: ${before}`);
  return source.replace(before, after);
}
const mutants = [
  {
    name: 'zero-report', file: 'return-pallet-saved-search.js', propertyRequired: true,
    changes: [["netBalance: row ? reportQuantity(row[indices.quantity]) : 0,", 'netBalance: 0,']]
  },
  {
    name: 'ignore-local-reservations', file: 'return-policy.js', propertyRequired: true,
    changes: [['(netBalance - reserved)', '(netBalance)']]
  },
  {
    name: 'allow-foreign-customer', file: 'return-pallet-saved-search.js', propertyRequired: true,
    changes: [['String(row[indices.customer]) !== String(customerId)', 'false']]
  },
  {
    name: 'allow-ambiguous-groups', file: 'return-pallet-saved-search.js', propertyRequired: true,
    changes: [['payload.rows.length > 1', 'false'], ['payload.rows.length === 1', 'payload.rows.length > 0']]
  },
  {
    name: 'coerce-malformed-quantity', file: 'return-pallet-saved-search.js', propertyRequired: true,
    changes: [['function reportQuantity(value) {', 'function reportQuantity(value) {\n  return Number(value) || 0;']]
  },
  {
    name: 'allow-foreign-url', file: 'netsuite.js', propertyRequired: true,
    changes: [['const target = new URL(url);\n  const account =', 'const target = new URL(url);\n  return target;\n  const account =']]
  },
  {
    name: 'wrong-default-deployment', file: 'config.js', propertyRequired: false,
    changes: [['env.NETSUITE_ACCOUNT_ID === "6518947"', 'false']]
  },
  {
    name: 'count-credit-headers', file: 'return-netsuite.js', propertyRequired: false,
    changes: [["AND tl.item = ${itemId} AND tl.iscogs = 'F' AND tl.mainline = 'F'",
      "AND tl.item = ${itemId} AND tl.iscogs = 'F'"]]
  },
  {
    name: 'legacy-ignores-deductions', file: 'return-policy.js', propertyRequired: false,
    changes: [['(values.fulfilled - values.netsuiteReturned - values.localReserved)', '(values.fulfilled)']]
  },
  {
    name: 'skip-deleted-credit-recovery', file: 'return-batch-ra-service.js', propertyRequired: false,
    changes: [['export async function reconcileMissingPalletCreditMemos(customerId, remoteBalance) {',
      'export async function reconcileMissingPalletCreditMemos(customerId, remoteBalance) {\n  return;']]
  }
];

try {
  cpSync('src', `${root}/src`, { recursive: true });
  cpSync('test/support', `${root}/test/support`, { recursive: true });
  for (const file of testFiles) { cpSync(file, `${root}/${file}`, { recursive: true }); }
  for (const name of ['node_modules', 'public', 'package.json']) {
    symlinkSync(`/app/${name}`, `${root}/${name}`);
  }
  const files = testFiles.map(file => `${root}/${file}`);
  for (const mutant of mutants) {
    const target = `${root}/src/${mutant.file}`;
    const original = readFileSync(target, 'utf8');
    let changed = original;
    for (const [before, after] of mutant.changes) { changed = replaceOnce(changed, before, after); }
    writeFileSync(target, changed);
    try {
      const fixed = run(`mutant-${mutant.name}`, ['--test', '--test-concurrency=1', ...files], { accepted: [1] });
      assert.ok(fixed.fail > 0, `${mutant.name} survived the complete focused suite`);
      assert.doesNotMatch(fixed.log, /SyntaxError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);
      const property = run(`property-mutant-${mutant.name}`, ['--test', '--test-concurrency=1',
        '--test-name-pattern=^property:', ...files], { accepted: [0, 1] });
      assert.doesNotMatch(property.log, /SyntaxError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);
      if (mutant.propertyRequired) { assert.ok(property.fail > 0, `${mutant.name} survived its properties`); }
      results.push({ name: mutant.name, killed: true, failedTests: fixed.fail,
        propertyKilled: property.fail > 0, propertyRequired: mutant.propertyRequired });
    } finally {
      writeFileSync(target, original);
    }
  }
  const restored = run('mutations-restored', ['--test', '--test-concurrency=1', ...files]);
  assert.equal(restored.fail, 0);
  writeFileSync(`${out}/mutations.json`, JSON.stringify({
    mutants: results, restoredTests: restored.tests,
    propertyLimits: 'Default deployment configuration, credit-identity SQL, legacy arithmetic and deleted-credit reconciliation use fixed-example tests; the parser, net arithmetic and URL properties do not claim to cover those behaviors.'
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
