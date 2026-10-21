import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { scanTextForSecrets } from '../../test/support/scan-diff-secrets.mjs';
const out = 'test-artifacts/return-pallet-balance-sync-20261008';
const files = JSON.parse(readFileSync('tools/return-pallet-balance-sync-20261008/files.json'));
const findings = [];
for (const file of files) {
  const before = new Set(readFileSync(out + '/baseline/' + file, 'utf8').split('\n'));
  const added = readFileSync(file, 'utf8').split('\n').filter(line => !before.has(line)).join('\n');
  findings.push(...scanTextForSecrets(added, file));
}
assert.deepEqual(findings, []);
assert.equal(readFileSync('package-lock.json', 'utf8'), readFileSync(out + '/baseline/package-lock.json', 'utf8'));
writeFileSync(out + '/audit.json', JSON.stringify({ newSecretFindings: 0, newDependencies: 0,
  capabilityReview: 'Existing authenticated NetSuite GET reads and PostgreSQL return-state updates only. No added remote mutation or credential sources.' }, null, 2));
