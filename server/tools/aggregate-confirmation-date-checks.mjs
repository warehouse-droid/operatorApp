import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import coverageLibrary from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
import { mutants } from '../test/support/aggregate-confirmation-date-mutation-loader.mjs';

const root = 'test-artifacts/aggregate-confirmation-date';
await mkdir(root, { recursive: true });
const mode = process.argv[2];
const tests = [
  'test/mbt/unit/aggregate-request-domain.test.js', 'test/mbt/unit/aggregate-request-access.test.js',
  'test/mbt/unit/aggregate-request-time.test.js', 'test/mbt/integration/aggregate-request-access.test.js',
  'test/mbt/integration/aggregate-request-repository.test.js', 'test/mbt/integration/aggregate-request-http.test.js',
  'test/mbt/integration/aggregate-request-browser.test.js', 'test/mbt/integration/aggregate-request-alert-browser.test.js'
];
if (mode === 'mutations') {
  const results = [];
  for (const [name, target] of mutants) {
    const result = spawnSync(process.execPath, ['--loader', './test/support/aggregate-confirmation-date-mutation-loader.mjs',
      '--test', '--test-name-pattern=confirmation date', `test/mbt/${target === 'domain' ? 'unit' : 'integration'}/aggregate-request-${target}.test.js`],
    { encoding: 'utf8', env: { ...process.env, AGGREGATE_DATE_MUTATION: name }, maxBuffer: 8 * 1024 * 1024 });
    const output = result.stdout + result.stderr;
    await writeFile(`${root}/mutation-${name}.log`, output);
    const killed = result.status !== 0 && /not ok \d+ - /.test(output) && output.includes(`AGGREGATE_DATE_MUTATION_APPLIED:${name}`);
    results.push({ name, killed });
    assert.ok(killed, `Surviving mutant ${name}`);
  }
  await writeFile(`${root}/mutations.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} else if (mode === 'coverage') {
  const changed = JSON.parse(await readFile('tools/aggregate-confirmation-date-changed-lines.json', 'utf8'));
  const map = coverageLibrary.createCoverageMap(JSON.parse(await readFile('test-artifacts/aggregate-confirmation-date-coverage/coverage-final.json', 'utf8')));
  for (const filename of ['aggregate-browser-coverage.json', 'aggregate-confirmation-date-browser.json']) {
    for (const entry of JSON.parse(await readFile(`test-artifacts/${filename}`, 'utf8'))) {
      const name = `public/${new URL(entry.url).pathname.split('/').at(-1)}`;
      if (!changed[name]) { continue; }
      const converter = v8ToIstanbul(name, 0, { source: entry.source });
      await converter.load(); converter.applyCoverage(entry.functions); map.merge(converter.toIstanbul());
    }
  }
  const result = {};
  for (const [name, lines] of Object.entries(changed)) {
    const file = map.files().find(item => item.endsWith('/' + name) || item === name);
    assert.ok(file, `Missing coverage: ${name}`);
    const counts = map.fileCoverageFor(file).getLineCoverage();
    const executable = lines.filter(line => counts[line] !== undefined);
    result[name] = { changedLines: executable.length, covered: executable.filter(line => counts[line] > 0).length,
      uncovered: executable.filter(line => counts[line] === 0) };
    assert.deepEqual(result[name].uncovered, [], name);
  }
  await writeFile(`${root}/coverage.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} else if (mode === 'health') {
  const digest = value => createHash('sha256').update(`20260925:${value}`).digest('hex');
  for (const file of tests.sort((left, right) => digest(left).localeCompare(digest(right)))) {
    console.log(`Suite health seed 20260925: ${file}`);
    const result = spawnSync(process.execPath, ['--test', file], { stdio: 'inherit', env: process.env });
    assert.equal(result.status, 0, file);
  }
} else { throw new Error('Choose mutations, coverage or health.'); }
