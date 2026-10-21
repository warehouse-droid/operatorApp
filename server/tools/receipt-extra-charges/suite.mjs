import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const mode = process.argv[2];
const files = mode === 'red' ? ['tools/receipt-extra-charges/unit.test.mjs']
  : mode === 'red-integration' ? ['tools/receipt-extra-charges/integration.test.mjs'] : [
  'test/mbt/unit/operator-netsuite-posting-service.red.test.js',
  'test/mbt/unit/operator-netsuite-posting-runtime-adapters.red.test.js',
  'test/mbt/unit/operator-direct-orderline-service.test.js',
  'test/mbt/unit/operator-netsuite-posting-domain.red.test.js',
  'test/mbt/unit/operator-posting-rounding.test.js',
  'test/mbt/unit/operator-posting-pack-quantities.test.js',
  'test/mbt/unit/receiving-followup-progress.test.js',
  'test/mbt/property/operator-netsuite-posting.property.test.js',
  'test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js',
  'test/mbt/integration/operator-netsuite-posting-repository.red.test.js',
  'test/mbt/integration/operator-posting-pack-quantities.test.js',
  'test/mbt/integration/operator-posting-rounding.test.js',
  'test/mbt/integration/operator-direct-orderline.test.js',
  'test/mbt/integration/operator-receiving-completed.test.js',
  'test/mbt/integration/receiving-followup.test.js',
  'test/mbt/integration/receiving-split-balance.test.js',
  'test/mbt/concurrency/receiving-followup.test.js',
  'test/mbt/concurrency/operator-netsuite-posting-concurrency.test.js'
];
if (!['baseline','red','red-integration'].includes(mode)) {
  files.push('tools/receipt-extra-charges/unit.test.mjs', 'tools/receipt-extra-charges/integration.test.mjs',
    'tools/receipt-extra-charges/property.test.mjs');
  files.sort((a,b) => [...a].reduce((n,c) => (n * 31 + c.charCodeAt(0)) % 997, 4042)
    - [...b].reduce((n,c) => (n * 31 + c.charCodeAt(0)) % 997, 4042));
}
const results = [];
if (mode === 'final') {
  rmSync('/evidence/coverage', { recursive: true, force: true });
  mkdirSync('/evidence/coverage/raw', { recursive: true });
}
for (const file of files) {
  const url = new URL(process.env.DATABASE_URL);
  const template = url.pathname.slice(1);
  const database = `receipt_charge_${process.pid}_${results.length}`;
  assert.match(template, /^[a-zA-Z0-9_]+$/);
  const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.href });
  await admin.connect();
  let result;
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
    url.pathname = `/${database}`;
    result = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', maxBuffer: 20000000,
      env: { ...process.env, DATABASE_URL: url.href,
        ...(mode === 'final' ? { NODE_V8_COVERAGE: '/evidence/coverage/raw' } : {}) }, timeout: 120000 });
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
  writeFileSync(`/evidence/${mode}-${file.replaceAll('/', '-')}.log`, result.stdout + result.stderr);
  const count = kind => Number(result.stdout.match(new RegExp(`^# ${kind} (\\d+)$`, 'm'))?.[1] || 0);
  const row = { file, exit: result.status, tests: count('tests'), pass: count('pass'), fail: count('fail'),
    failures: [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]) };
  results.push(row); console.log(JSON.stringify(row));
}
writeFileSync(`/evidence/${mode}-results.json`, JSON.stringify(results, null, 2));
if (mode === 'final') {
  const baseline = JSON.parse(readFileSync('/evidence/baseline-results.json', 'utf8'));
  for (const result of results) {
    if (result.file.startsWith('tools/')) { assert.equal(result.exit, 0, result.file); }
    else {
      const prior = baseline.find(row => row.file === result.file);
      assert.deepEqual(result.failures, prior.failures, result.file);
      assert.equal(result.exit, prior.exit, result.file);
      assert.equal(result.tests, prior.tests, result.file);
    }
  }
} else if (mode !== 'baseline') {
  assert.ok(results.every(row => row.exit === 0), 'One or more receipt posting suites failed');
}
