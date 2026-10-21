import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'espree';
import coverageLibrary from 'istanbul-lib-coverage';
import { run, out, sourceFiles, testFiles } from './checks.mjs';

for (const file of sourceFiles) {
  run(`syntax-${basename(file)}`, ['--check', file]);
}
mkdirSync(`${out}/baseline-src`, { recursive: true });
for (const file of sourceFiles) {
  const path = `/baseline/${file}`;
  writeFileSync(`${out}/baseline-src/${basename(file)}`, existsSync(path) ? readFileSync(path) : '');
}
const eslint = ['node_modules/eslint/bin/eslint.js', '--config',
  'tools/pallet-saved-search-20261020/eslint.config.mjs', '--format=json'];
const beforeLint = run('lint-baseline', [...eslint,
  ...sourceFiles.map(file => `${out}/baseline-src/${basename(file)}`)], { accepted: [0, 1] });
const afterLint = run('lint-final', [...eslint, ...sourceFiles], { accepted: [0, 1] });
function lintFindings(log) {
  const findings = [];
  for (const file of JSON.parse(log)) {
    const source = readFileSync(file.filePath, 'utf8').split('\n');
    for (const message of file.messages) {
      findings.push(JSON.stringify([basename(file.filePath), message.ruleId, message.severity,
        message.message.replace(/on line \d+ column \d+/g, 'on line <position>'), source[message.line - 1]?.trim()]));
    }
  }
  return findings;
}
function extraFindings(before, after) {
  const remaining = [...before];
  return after.filter(finding => {
    const index = remaining.indexOf(finding);
    if (index < 0) { return true; }
    remaining.splice(index, 1);
    return false;
  });
}
const oldLint = lintFindings(beforeLint.log), newLint = lintFindings(afterLint.log);
const addedLint = extraFindings(oldLint, newLint);
writeFileSync(`${out}/lint-comparison.json`, JSON.stringify({
  baselineCount: oldLint.length, finalCount: newLint.length, newFindings: addedLint
}, null, 2));
assert.deepEqual(addedLint, [], 'New or changed lint findings');
run('lint-tests-tools', [...eslint, '--max-warnings=0', ...testFiles,
  'test/support/pallet-saved-search-fixture.js',
  'tools/pallet-saved-search-20261020/checks.mjs',
  'tools/pallet-saved-search-20261020/static.mjs',
  'tools/pallet-saved-search-20261020/live-read.mjs',
  'tools/pallet-saved-search-20261020/mutations.mjs']);

// Type-check the actual standalone parser, plus exact changed functions with
// their external module boundaries declared. Compare old function diagnostics.
const functions = new Map([
  ['config.js', ['palletBalanceRestletUrl']],
  ['netsuite.js', ['readNetSuiteRestlet', 'restletReadTarget']],
  ['return-netsuite.js', ['positiveId', 'palletCreditIdentityQuery', 'savedPalletBalance', 'fetchPalletBalanceFromNetSuite']],
  ['return-policy.js', ['finiteNonNegativeNumber', 'returnBalance']],
  ['return-repository.js', ['customerHasLocalPalletReturns', 'palletBalanceSource', 'customerPalletBalance']]
]);
const boundaries = ['config', 'query', 'assertNetSuiteDirectAccessEnabled', 'getAccessToken',
  'timedNetSuiteTextRequest', 'parsedRestletPayload', 'restletErrorDetail', 'suiteqlAll',
  'parsePalletSavedSearch', 'palletBalanceCache', 'palletBalanceInflight', 'cachedValue',
  'storeCachedValue', 'PALLET_BALANCE_CACHE_TTL_MS', 'resolvePalletItemFromNetSuite',
  'palletActivityQuery', 'summarizePalletActivityRows', 'fetchPalletReturnCreditsFromNetSuite',
  'reconcileMissingPalletCreditMemos', 'localPalletReserved'];
function typeInput(root) {
  let text = boundaries.map(name => `/** @type {any} */ let ${name};`).join('\n') + '\n';
  for (const [name, selected] of functions) {
    const source = readFileSync(`${root}/${name}`, 'utf8');
    const parsed = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, comment: true });
    for (const node of parsed.body) {
      const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
      if (declaration?.type === 'FunctionDeclaration' && selected.includes(declaration.id?.name)) {
        const comment = parsed.comments.findLast(value => value.range[1] <= node.range[0]);
        const start = comment && !source.slice(comment.range[1], node.range[0]).trim()
          ? comment.range[0] : node.range[0];
        text += source.slice(start, node.range[1]) + '\n';
      }
    }
  }
  return text;
}
writeFileSync(`${out}/types-baseline.mjs`, typeInput('/baseline/src'));
writeFileSync(`${out}/types-final.mjs`, typeInput('src'));
const tsc = ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit',
  '--strict', '--skipLibCheck', '--target', 'es2023', '--module', 'nodenext'];
run('types-parser', [...tsc, 'src/return-pallet-saved-search.js']);
const oldTypes = run('types-baseline', [...tsc, `${out}/types-baseline.mjs`], { accepted: [0, 1] });
const newTypes = run('types-final', [...tsc, `${out}/types-final.mjs`], { accepted: [0, 1] });
const errors = log => [...log.matchAll(/error TS\d+:[^\n]+/g)].map(match => match[0]);
const addedTypes = extraFindings(errors(oldTypes.log), errors(newTypes.log));
writeFileSync(`${out}/types-comparison.json`, JSON.stringify({
  baseline: errors(oldTypes.log), final: errors(newTypes.log), newFindings: addedTypes
}, null, 2));
assert.deepEqual(addedTypes, [], 'New type diagnostics in changed functions');
run('secrets', ['test/support/scan-diff-secrets.mjs', ...sourceFiles, ...testFiles,
  'test/support/pallet-saved-search-fixture.js',
  'test/pallet-saved-search-integration-spec.json',
  'tools/pallet-saved-search-20261020/checks.mjs',
  'tools/pallet-saved-search-20261020/static.mjs',
  'tools/pallet-saved-search-20261020/live-read.mjs',
  'tools/pallet-saved-search-20261020/mutations.mjs',
  'tools/pallet-saved-search-20261020/test.sh',
  'tools/pallet-saved-search-20261020/release.py']);

const coverage = coverageLibrary.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`, 'utf8')));
const changes = JSON.parse(readFileSync('/baseline/changed-lines.json', 'utf8'));
const report = {};
for (const [file, lines] of Object.entries(changes)) {
  const key = coverage.files().find(path => path.endsWith(`/${file}`));
  assert.ok(key, `No coverage for ${file}`);
  const measured = coverage.fileCoverageFor(key).getLineCoverage();
  report[file] = {
    changedExecutableLines: lines.filter(line => measured[line] !== undefined),
    uncovered: lines.filter(line => measured[line] === 0),
    nonExecutable: lines.filter(line => measured[line] === undefined)
  };
}
writeFileSync(`${out}/changed-coverage.json`, JSON.stringify(report, null, 2));
assert.deepEqual(Object.values(report).flatMap(value => value.uncovered), [], 'Uncovered changed lines');
