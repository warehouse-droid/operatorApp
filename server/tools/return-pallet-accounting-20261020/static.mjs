import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { run, out, sourceFile, testFile } from './checks.mjs';

const source = readFileSync(sourceFile, 'utf8');
const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return text.slice(from, to);
};
// Check the exact changed function and its ID validator without pulling in
// unrelated, untyped application modules.
const extract = text => between(text, 'function positiveId(', 'function returnOrderFilter(')
  + between(text, 'export function palletActivityQuery(', 'export async function fetchPalletBalanceFromNetSuite(');
writeFileSync(`${out}/query-static.mjs`, extract(source));
writeFileSync(`${out}/query-baseline.mjs`, extract(readFileSync('/baseline/return-netsuite.js', 'utf8')));
run('syntax', ['--check', sourceFile]);
const typeArgs = ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit',
  '--skipLibCheck', '--target', 'es2023', '--module', 'nodenext'];
const beforeTypes = run('types-baseline', [...typeArgs, `${out}/query-baseline.mjs`], { accepted: [0, 1] });
const afterTypes = run('types-final', [...typeArgs, `${out}/query-static.mjs`], { accepted: [0, 1] });
const diagnostics = result => [...result.log.matchAll(/error TS\d+:[^\n]+/g)].map(match => match[0]).sort();
assert.deepEqual(diagnostics(afterTypes), diagnostics(beforeTypes), 'Type checking must have zero new diagnostics');
writeFileSync(`${out}/types-comparison.json`, JSON.stringify({
  baseline: diagnostics(beforeTypes), final: diagnostics(afterTypes), newDiagnostics: []
}, null, 2));
run('lint', ['node_modules/eslint/bin/eslint.js', '--config',
  'tools/return-pallet-accounting-20261020/eslint.config.mjs', '--max-warnings=0',
  `${out}/query-static.mjs`, testFile,
  'tools/return-pallet-accounting-20261020/checks.mjs',
  'tools/return-pallet-accounting-20261020/static.mjs',
  'tools/return-pallet-accounting-20261020/mutations.mjs']);
run('secrets', ['test/support/scan-diff-secrets.mjs', sourceFile, testFile,
  'test/return-pallet-accounting-spec.json',
  'tools/return-pallet-accounting-20261020/checks.mjs',
  'tools/return-pallet-accounting-20261020/static.mjs',
  'tools/return-pallet-accounting-20261020/mutations.mjs',
  'tools/return-pallet-accounting-20261020/test.sh',
  'tools/return-pallet-accounting-20261020/release.py']);

const coverage = JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`, 'utf8'));
const entry = Object.values(coverage).find(file => file.path.endsWith(`/${sourceFile}`));
assert.ok(entry);
const fn = Object.entries(entry.fnMap).find(([, value]) => value.name === 'palletActivityQuery');
assert.ok(fn && entry.f[fn[0]] > 0, 'The production query generator must execute');
const queryLine = source.slice(0, source.indexOf('export function palletActivityQuery(')).split('\n').length;
const lines = source.split('\n');
const changed = lines.map((line, index) => ({ line, number: index + 1 }))
  .filter(row => row.number > queryLine && row.number < queryLine + 75 && /AND tl.iscogs = 'F'/.test(row.line));
assert.equal(changed.length, 2);
for (const row of changed) {
  const executed = Object.entries(entry.statementMap).some(([id, location]) =>
    location.start.line <= row.number && location.end.line >= row.number && entry.s[id] > 0);
  assert.ok(executed, `Changed SQL line ${row.number} was not evaluated`);
}
writeFileSync(`${out}/changed-coverage.json`, JSON.stringify({
  queryFunctionExecutions: entry.f[fn[0]], changedSqlLines: changed.map(row => row.number),
  executedChangedSqlLines: changed.length,
  note: 'SQL predicate behavior is verified by executing the generated query in PostgreSQL.'
}, null, 2));
