import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { scanPaths } from '../test/support/scan-diff-secrets.mjs';

const files = [
  'src/dispatch-history-mode.js', 'src/dispatch-load-assignment.js',
  'src/dispatch-planner-v2-repository.js', 'src/dispatch-pickup-visits.js',
  'src/dispatch-historical-order-snapshots.js', 'src/order-dependency-repository.js',
  'src/scm-dependency-preview-service.js',
  'test/dispatch/integration/to-dependency-packing-independent.test.js',
  'test/dispatch/integration/retained-history-save.test.js',
  'test/dispatch/integration/historical-missing-order-snapshot.test.js',
  'test/dispatch/unit/executed-prefix-historical-reflexivity.test.js',
  'test/dispatch/unit/historical-group-pickups.test.js',
  'test/dispatch/unit/historical-replay-fixture-classification.test.js',
  'test/dispatch/property/historical-planning-safety.property.test.js',
  'test/dispatch/integration/scm-to-untouched-lines.test.js',
  'test/dispatch/integration/scm-dependency-preview-blockers.red.test.js',
  'test/dispatch/integration/transfer-completed-unlink.test.js',
  'test/mbt/integration/link-to-fix.test.js',
  ...(await readdir('tools')).filter(name => name.startsWith('dispatch-all-history-')).map(name => `tools/${name}`)
];
const findings = await scanPaths(files);
const environment = (await readFile('tools/dispatch-all-history-environment.sh', 'utf8')).split('\n');
const reviewed = findings.filter(finding => finding.file === 'tools/dispatch-all-history-environment.sh'
  && finding.kind === 'credential_assignment'
  && environment[finding.line - 1].trim()
    === '-e DATABASE_URL="postgres://mbt_test:history_local_only@db:5432/$runtime_database" \\'); // secret-scan: allow literal matcher for disposable test credentials
const unresolved = findings.filter(finding => !reviewed.includes(finding));
const toolVersions = Object.fromEntries(await Promise.all(['pg', 'c8', 'eslint', 'typescript', 'fast-check'].map(async name => {
  const metadata = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  return [name, metadata.version];
})));
const report = { completedAt: new Date().toISOString(), files, unresolved,
  toolVersions: { node: process.version, v8: process.versions.v8, ...toolVersions },
  reviewed: reviewed.map(finding => ({ ...finding,
    reason: 'Literal credentials for the disposable isolated test database; no production credential.' })),
  capabilityReview: 'The new production helper reads the existing PostgreSQL database. No new external network, subprocess or filesystem capability in production source.',
  dependencyReview: 'No dependency files changed for these fixes; existing test-image tools are used.' };
await writeFile('test-artifacts/dispatch-all-history-20261002/secrets.json', JSON.stringify(report, null, 2), { mode: 0o600 });
assert.equal(unresolved.length, 0, 'Unreviewed potential credentials must be resolved');
console.log(JSON.stringify({ scannedFiles: files.length, reviewedIsolatedCredentials: reviewed.length, unresolved: unresolved.length }));
