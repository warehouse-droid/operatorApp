import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import coverageLibrary from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
import { mutants } from '../test/support/aggregate-next-request-mutation-loader.mjs';

function run(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env, maxBuffer: 20 * 1024 * 1024, ...options });
}
if (process.argv[2] === 'coverage') {
  const changed = JSON.parse(await readFile('tools/aggregate-next-request-changed-lines.json', 'utf8'));
  const map = coverageLibrary.createCoverageMap(JSON.parse(await readFile('test-artifacts/aggregate-next-request-coverage/coverage-final.json', 'utf8')));
  const entries = JSON.parse(await readFile('test-artifacts/aggregate-browser-coverage.json', 'utf8'));
  for (const entry of entries) {
    const filename = `public/${new URL(entry.url).pathname.split('/').at(-1)}`;
    if (!changed[filename]) { continue; }
    const converter = v8ToIstanbul(filename, 0, { source: entry.source });
    await converter.load(); converter.applyCoverage(entry.functions); map.merge(converter.toIstanbul());
  }
  const result = {};
  for (const [name, lines] of Object.entries(changed)) {
    const file = map.files().find(item => item.endsWith('/' + name) || item === name);
    assert.ok(file, `Missing coverage for ${name}`);
    const coverage = map.fileCoverageFor(file), counts = coverage.getLineCoverage();
    const executable = lines.filter(line => counts[line] !== undefined);
    result[name] = { changedLines: executable.length, covered: executable.filter(line => counts[line] > 0).length,
      uncovered: executable.filter(line => counts[line] === 0), summary: coverage.toSummary().toJSON() };
    assert.deepEqual(result[name].uncovered, []);
  }
  await writeFile('test-artifacts/aggregate-next-request-coverage.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} else if (process.argv[2] === 'mutations') {
  const root = 'test-artifacts/aggregate-next-request-mutations';
  await mkdir(root, { recursive: true });
  const results = [];
  for (const [name, target] of mutants) {
    for (const propertiesOnly of [false, true]) {
      const args = ['--loader', './test/support/aggregate-next-request-mutation-loader.mjs', '--test'];
      if (propertiesOnly) { args.push('--test-name-pattern=property: (only unfinished|each material memo)'); }
      args.push(`test/mbt/${target === 'domain' ? 'unit' : 'integration'}/aggregate-request-${target}.test.js`);
      const result = run(args, { env: { ...process.env, AGGREGATE_CYCLE_MUTATION: name } });
      const output = result.stdout + result.stderr;
      await writeFile(`${root}/${name}-${propertiesOnly ? 'properties' : 'all'}.log`, output);
      const killed = result.status !== 0 && /not ok \d+ - /.test(output) && output.includes(`AGGREGATE_CYCLE_MUTATION_APPLIED:${name}`);
      assert.ok(killed, `Surviving mutant ${name}, propertiesOnly=${propertiesOnly}`);
      results.push({ name, propertiesOnly, killed });
    }
  }
  await writeFile(`${root}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} else if (process.argv[2] === 'static') {
  for (const args of [
    ['tools/aggregate-checks.mjs', 'static'],
    ['node_modules/eslint/bin/eslint.js', '--config', 'tools/aggregate-eslint.config.mjs',
      'tools/aggregate-next-request-checks.mjs', 'tools/aggregate-next-request-migration.mjs',
      'tools/aggregate-next-request-concurrency.mjs',
      'test/support/aggregate-next-request-mutation-loader.mjs']
  ]) {
    const result = run(args, { stdio: 'inherit' });
    assert.equal(result.status, 0);
  }
} else { throw new Error('Choose coverage, mutations or static.'); }
