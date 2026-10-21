import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { run } from './check.mjs';
const out = 'test-artifacts/return-pallet-balance-sync-20261008';
const testFile = 'test/mbt/integration/return-pallet-balance-sync.test.js';
const mutants = [
  { name: 'serve-cached-balance', edits: [['src/return-repository.js', '    { force }\n  );', '    { force: false }\n  );']], pattern: 'submission rechecks' },
  { name: 'trust-generic-404', edits: [['src/netsuite.js', '&& error.netsuiteErrorCodes?.includes("NONEXISTENT_ID")', '&& true']], pattern: 'generated', property: true },
  { name: 'discard-unindexed-reservation', edits: [['src/return-repository.js', 'return total + (observed ? 0 : Number(row.pallet_quantity));', 'return total;']], pattern: 'unindexed CM' },
  { name: 'discard-local-only-reservation', edits: [['src/return-repository.js', "AND COALESCE(a.sync_status,r.netsuite_sync_status,'') <> 'cancelled'", "AND COALESCE(a.sync_status,r.netsuite_sync_status,'') NOT IN ('cancelled','disabled')"]], pattern: 'pending and local-only' },
  { name: 'release-unverified-missing-credit', edits: [
    ['src/return-batch-ra-service.js', "AND a.netsuite_snapshot->>'id'=a.netsuite_transaction_id::text", 'AND true'],
    ['src/return-batch-ra-service.js', '&& Number(batch.netsuite_snapshot?.id) === Number(transactionId)', '&& true']], pattern: 'never verified' },
  { name: 'keep-cancelled-reservation', edits: [['src/return-repository.js', "AND COALESCE(a.sync_status,r.netsuite_sync_status,'') <> 'cancelled'", 'AND true']], pattern: 'confirmed cancelled RAs' }
];
const root = mkdtempSync('/tmp/return-pallet-balance-mutants-');
const results = [];
try {
  for (const directory of ['src', 'public', 'test']) cpSync(directory, root + '/' + directory, { recursive: true });
  for (const directory of ['node_modules', 'contracts', 'migrations', 'test-artifacts', 'tools']) symlinkSync(resolve(directory), root + '/' + directory);
  cpSync('package.json', root + '/package.json');
  for (const mutant of mutants) {
    const originals = new Map();
    try {
      for (const [file, from, to] of mutant.edits) {
        const path = root + '/' + file;
        const source = readFileSync(path, 'utf8');
        if (!originals.has(path)) originals.set(path, source);
        assert.equal(source.split(from).length, 2, mutant.name);
        writeFileSync(path, source.replace(from, to));
      }
      const result = run('mutant-' + mutant.name, ['--test', '--test-name-pattern=' + mutant.pattern, testFile], { cwd: root, accepted: [1] });
      assert.ok(result.fail > 0 && !/ERR_MODULE_NOT_FOUND|SyntaxError/.test(result.log));
      results.push({ name: mutant.name, killed: true, propertySuiteAlone: mutant.property === true });
    } finally {
      for (const [path, source] of originals) writeFileSync(path, source);
    }
  }
  run('mutation-restored', ['--test', testFile], { cwd: root });
} finally { rmSync(root, { recursive: true, force: true }); }
writeFileSync(out + '/mutations.json', JSON.stringify(results, null, 2));
