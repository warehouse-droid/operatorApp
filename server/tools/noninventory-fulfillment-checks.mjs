import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { ESLint } from 'eslint';
import v8ToIstanbul from 'v8-to-istanbul';
import coverageLibrary from 'istanbul-lib-coverage';

const out = 'test-artifacts/noninventory-fulfillment';
const files = Object.keys(JSON.parse(readFileSync(out+'/baseline-hashes.json')));
const tests = ['test/mbt/unit/noninventory-fulfillment.test.js', 'test/mbt/integration/noninventory-fulfillment.test.js'];
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(readFileSync(file)).digest('hex')]));
const added = (before, after) => {
  const remaining = [...before];
  return after.filter(value => { const i = remaining.indexOf(value); if (i < 0) { return true; } remaining.splice(i, 1); return false; });
};
const save = (name, data) => writeFileSync(`${out}/${name}.json`, JSON.stringify(data, null, 2)+'\n');

if (process.argv[2] === 'static') {
  const lint = new ESLint({ overrideConfigFile: 'tools/noninventory-fulfillment-eslint.config.mjs' });
  const diagnostics = results => results.flatMap(row => row.messages.map(({ ruleId, message, severity }) => JSON.stringify({ ruleId, message, severity }))).sort();
  const typeRoot = mkdtempSync(path.join(tmpdir(), 'noninventory-types-'));
  mkdirSync(typeRoot+'/src');
  symlinkSync(path.resolve('node_modules'), typeRoot+'/node_modules');
  writeFileSync(typeRoot+'/package.json', '{"type":"module"}');
  function types(source, file, label) {
    writeFileSync(typeRoot+'/'+file, source);
    const result = spawnSync(path.resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--allowJs', '--checkJs', '--noEmit', '--noResolve',
      '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', file], { cwd: typeRoot, encoding: 'utf8', maxBuffer: 20e6 });
    assert.notEqual(result.status, null, result.error?.message);
    writeFileSync(`${out}/types-${label}-${path.basename(file)}.log`, result.stdout+result.stderr);
    return (result.stdout+result.stderr).split('\n').filter(Boolean).map(line => line.replace(/\(\d+,\d+\)/gu, '(LINE,COLUMN)')).sort();
  }
  const coverage = coverageLibrary.createCoverageMap({});
  for (const name of readdirSync(out+'/coverage').filter(candidate => candidate.endsWith('.json'))) {
    for (const entry of JSON.parse(readFileSync(out+'/coverage/'+name)).result) {
      const file = files.find(candidate => entry.url === 'file:///app/'+candidate);
      if (!file) { continue; }
      const converter = v8ToIstanbul('/app/'+file, 0, { source: readFileSync(file, 'utf8') });
      await converter.load(); converter.applyCoverage(entry.functions); coverage.merge(converter.toIstanbul());
    }
  }
  const changes = JSON.parse(readFileSync(out+'/changes.json'));
  const results = [];
  for (const file of files) {
    const before = readFileSync(out+'/before/'+file, 'utf8'), after = readFileSync(file, 'utf8');
    assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0, file);
    const lintAdded = added(diagnostics(await lint.lintText(before, { filePath: file })), diagnostics(await lint.lintText(after, { filePath: file })));
    const typeAdded = added(types(before, file, 'baseline'), types(after, file, 'candidate'));
    const lineCounts = coverage.fileCoverageFor('/app/'+file).getLineCoverage();
    const changed = changes[file].filter(line => Object.hasOwn(lineCounts, line));
    const uncovered = changed.filter(line => lineCounts[line] === 0);
    results.push({ file, syntax: true, lintAdded, typeAdded, coverage: { covered: changed.length-uncovered.length, total: changed.length, uncovered } });
  }
  const extra = diagnostics(await lint.lintFiles([...tests, 'tools/noninventory-fulfillment-tests.mjs', 'tools/noninventory-fulfillment-checks.mjs', 'tools/noninventory-fulfillment-mutants.mjs', 'tools/noninventory-fulfillment-live.mjs']));
  const patch = readFileSync(out+'/release.patch', 'utf8').split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  assert.doesNotMatch(patch, /AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{35,}/u);
  const versions = Object.fromEntries(['typescript', 'eslint', 'fast-check', 'v8-to-istanbul'].map(packageName => [packageName, JSON.parse(readFileSync('node_modules/'+packageName+'/package.json')).version]));
  save('static-evidence', { results, newToolLint: extra, secrets: 'no credential patterns in added runtime lines', versions: { node: process.version, ...versions }, sourceHashes: hashes() });
  console.log(JSON.stringify({ results, newToolLint: extra }));
  assert.deepEqual(extra, [], 'New test/tool lint diagnostics');
  for (const result of results) { assert.deepEqual(result.lintAdded, [], result.file); assert.deepEqual(result.typeAdded, [], result.file); assert.deepEqual(result.coverage.uncovered, [], result.file); }
} else if (process.argv[2] === 'mutations') {
  const before = hashes(), results = [];
  function mutate(name, propertyOnly = false) {
    const args = ['--loader', './tools/noninventory-fulfillment-mutants.mjs', '--test', '--test-concurrency=1'];
    if (propertyOnly) { args.push('--test-name-pattern=^property:'); }
    const run = spawnSync(process.execPath, [...args, ...tests], { encoding: 'utf8', maxBuffer: 20e6,
      env: { ...process.env, NONINVENTORY_MUTANT: name } });
    const output = run.stdout+run.stderr;
    writeFileSync(`${out}/mutant-${name}${propertyOnly ? '-property' : ''}.log`, output);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|Mutation anchor must be unique/u);
    return run.status === 1 && /ERR_ASSERTION|Property failed|OPERATOR_NETSUITE_POSTING_(?:NO_LINES|LINE_MAPPING_UNRESOLVED)/u.test(output);
  }
  for (const name of ['selection', 'deselection', 'outstanding', 'stored', 'automatic', 'receiving', 'visibility']) {
    const killed = mutate(name), propertyKilled = mutate(name, true);
    results.push({ name, killed, propertyKilled });
    assert.equal(killed, true, name+' survived');
  }
  assert.deepEqual(hashes(), before);
  save('mutation-evidence', { results, sourcesRestored: true, sourceHashes: hashes() });
  console.log(JSON.stringify({ results }));
} else { throw new Error('Use static or mutations'); }
