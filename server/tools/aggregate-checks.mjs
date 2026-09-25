import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import coverageLibrary from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

const featureTests = [
  'test/mbt/unit/aggregate-request-domain.test.js', 'test/mbt/unit/aggregate-request-access.test.js',
  'test/mbt/integration/aggregate-request-access.test.js',
  'test/mbt/integration/aggregate-request-repository.test.js',
  'test/mbt/integration/aggregate-request-http.test.js',
  'test/mbt/integration/aggregate-request-browser.test.js',
  'test/mbt/unit/aggregate-request-time.test.js', 'test/mbt/integration/aggregate-request-alert-browser.test.js'
];
const featureCode = [
  'src/aggregate-request-domain.js', 'src/aggregate-request-repository.js', 'src/aggregate-request-router.js',
  'src/aggregate-request-access-repository.js', 'src/aggregate-request-access-router.js', 'public/aggregate-requester.js',
  'public/aggregate-requests.js', 'public/aggregate-requests-i18n.js', 'public/scm-stock-request-tabs.js', 'public/scm-aggregate-alert.js'
];
const wiring = ['src/server.js', 'src/auth-repository.js', 'public/control.js', 'public/app-sidebar.js', 'public/dispatch-auth.js', 'public/operator.js', 'public/i18n.js', 'public/service-worker.js', 'public/scm-stock-requests.js', 'public/scm-special-stock-requests.js'];
function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) { throw new Error(`Check failed: node ${args.join(' ')}`); }
}

if (process.argv[2] === 'static') {
  for (const file of [...featureCode, ...wiring, ...featureTests]) { run(['--check', file]); }
  run(['node_modules/eslint/bin/eslint.js', '--config', 'tools/aggregate-eslint.config.mjs', ...featureCode, ...featureTests,
    'tools/aggregate-checks.mjs', 'tools/aggregate-mutations.mjs', 'test/support/aggregate-mutation-loader.mjs']);
  run(['node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--skipLibCheck', 'src/aggregate-request-domain.js']);
  console.log('Syntax, lint and domain type checks passed.');
} else if (process.argv[2] === 'shuffle') {
  const digest = value => createHash('sha256').update(`20260922:${value}`).digest('hex');
  for (const file of [...featureTests].sort((a, b) => digest(a).localeCompare(digest(b)))) {
    console.log(`Suite health seed 20260922: ${file}`);
    run(['--test', file]);
  }
} else if (process.argv[2] === 'browser-coverage') {
  const entries = JSON.parse(await readFile('test-artifacts/aggregate-browser-coverage.json', 'utf8'));
  const merged = coverageLibrary.createCoverageMap({});
  for (const entry of entries) {
    if (!/\/(?:aggregate-requests|scm-stock-request-tabs)\.js(?:\?|$)/.test(entry.url)) { continue; }
    const filename = `public/${new URL(entry.url).pathname.split('/').at(-1)}`;
    const converter = v8ToIstanbul(filename, 0, { source: entry.source });
    await converter.load();
    converter.applyCoverage(entry.functions);
    merged.merge(converter.toIstanbul());
  }
  const summary = Object.fromEntries(merged.files().map(file => [file, merged.fileCoverageFor(file).toSummary().toJSON()]));
  await writeFile('test-artifacts/aggregate-browser-summary.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (Object.keys(summary).length !== 2 || Object.values(summary).some(file =>
    file.lines.pct < 95 || file.functions.pct < 95 || file.branches.pct < 90)) {
    throw new Error('Aggregate browser coverage is below the required thresholds.');
  }
} else if (process.argv[2] === 'source') {
  const files = [...featureCode, ...wiring, ...featureTests, 'migrations/215_aggregate_requests.sql',
    'public/aggregate-requests.html', 'public/aggregate-requests.css', 'public/scm-stock-requests.html', 'public/operator.html',
    'package.json', 'tools/aggregate-checks.mjs', 'tools/aggregate-mutations.mjs', 'tools/aggregate-eslint.config.mjs',
    'tools/aggregate-test-env.sh', 'tools/aggregate-gauntlet.sh', 'tools/aggregate-migration-check.mjs',
    'tools/aggregate-regression.py', 'test/support/aggregate-mutation-loader.mjs',
    'test/mbt/unit/operations-navigation-enhancements.test.js', 'test/mbt/unit/operator-delivery-refresh.test.js'];
  const hashes = {};
  for (const file of files) { hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex'); }
  const result = { node: process.version, files: hashes, sourceHash: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') };
  await writeFile('test-artifacts/aggregate-source.json', JSON.stringify(result, null, 2));
  console.log(result.sourceHash);
} else { throw new Error('Choose static, shuffle, browser-coverage or source.'); }
