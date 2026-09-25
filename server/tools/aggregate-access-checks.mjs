import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import coverageLibrary from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
const scope = JSON.parse(await readFile('tools/aggregate-access-files.json', 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tooling = ['tools/aggregate-access-checks.mjs', 'tools/aggregate-access-files.json', 'tools/aggregate-access-changed-lines.json',
  'tools/aggregate-access-gauntlet.sh', 'tools/aggregate-access-deploy.py', 'tools/aggregate-access-mutations.mjs',
  'tools/aggregate-access-live.mjs', 'tools/aggregate-access-migration-check.mjs', 'tools/aggregate-test-env.sh', 'tools/aggregate-checks.mjs',
  'tools/aggregate-eslint.config.mjs', 'test/support/aggregate-access-mutation-loader.mjs',
  'test/mbt/unit/operations-navigation-enhancements.test.js', 'test/mbt/unit/operator-delivery-refresh.test.js',
  'tools/aggregate-deploy.py', 'tools/operator-display-settings-deploy.py', 'tools/aggregate-live.mjs'];
function run(args) {
  const result = spawnSync(process.execPath, args, { env: process.env, stdio: 'inherit' });
  if (result.status !== 0) { throw new Error(`Failed: ${args.join(' ')}`); }
}
if (process.argv[2] === 'source') {
  const files = {};
  for (const file of [...scope.runtime, ...scope.tests, ...tooling].sort()) { files[file] = hash(await readFile(file)); }
  const result = { node: process.version, files, sourceHash: hash(JSON.stringify(files)) };
  await writeFile('test-artifacts/aggregate-access-source.json', JSON.stringify(result, null, 2));
  console.log(result.sourceHash);
} else if (process.argv[2] === 'coverage') {
  const changed = JSON.parse(await readFile('tools/aggregate-access-changed-lines.json', 'utf8'));
  const server = JSON.parse(await readFile('test-artifacts/aggregate-access-server-coverage/coverage-final.json', 'utf8'));
  const map = coverageLibrary.createCoverageMap(server);
  const entries = JSON.parse(await readFile('test-artifacts/aggregate-browser-coverage.json', 'utf8'));
  for (const entry of entries) {
    const filename = `public/${new URL(entry.url).pathname.split('/').at(-1)}`;
    if (!changed[filename]) { continue; }
    const converter = v8ToIstanbul(filename, 0, { source: entry.source });
    await converter.load(); converter.applyCoverage(entry.functions); map.merge(converter.toIstanbul());
  }
  const result = {};
  for (const [filename, lines] of Object.entries(changed)) {
    const file = map.files().find(item => item.endsWith('/' + filename) || item === filename);
    if (!file) { result[filename] = { uninstrumented: true }; continue; }
    const coverage = map.fileCoverageFor(file), counts = coverage.getLineCoverage();
    const executable = lines.filter(line => counts[line] !== undefined);
    result[filename] = { changedLines: executable.length, covered: executable.filter(line => counts[line] > 0).length,
      uncovered: executable.filter(line => counts[line] === 0), allFileSummary: coverage.toSummary().toJSON() };
  }
  await writeFile('test-artifacts/aggregate-access-coverage.json', JSON.stringify(result, null, 2));
  if (Object.values(result).some(row => !row.uninstrumented && row.changedLines !== row.covered)) { throw new Error('Untested changed lines remain.'); }
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([file, { allFileSummary: _allFileSummary, ...summary }]) => [file, summary])), null, 2));
} else if (process.argv[2] === 'static') {
  run(['tools/aggregate-checks.mjs', 'static']);
  run(['node_modules/eslint/bin/eslint.js', '--config', 'tools/aggregate-eslint.config.mjs',
    'tools/aggregate-access-checks.mjs', 'tools/aggregate-access-mutations.mjs',
    'tools/aggregate-access-migration-check.mjs', 'test/support/aggregate-access-mutation-loader.mjs']);
} else { throw new Error('Choose source, coverage or static'); }
