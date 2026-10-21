import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, out, sourceFile, testFile } from './checks.mjs';

const source = readFileSync(sourceFile, 'utf8');
const queryStart = source.indexOf('export function palletActivityQuery(');
const queryEnd = source.indexOf('export async function fetchPalletBalanceFromNetSuite(', queryStart);
const query = source.slice(queryStart, queryEnd);
const filter = "      AND tl.iscogs = 'F'";
const mutants = [
  { name: 'count-fulfillment-accounting', query: query.replace(filter, '') },
  { name: 'omit-fulfillment-mainline', query: query.replace(filter, `${filter}\n      AND tl.mainline = 'F'`) },
  { name: 'count-credit-accounting', query: query.replace(`${filter}\n      AND tl.mainline = 'F'`, "      AND tl.mainline = 'F'") },
  { name: 'restrict-balance-to-yard-150', query: query.replaceAll(filter, `${filter}\n      AND tl.location = 26`) },
  { name: 'include-other-customers', query: query.replaceAll('     AND c.id = ${id}', '     AND c.id > 0') },
  { name: 'accept-invalid-id', source: source.replace('if (!Number.isSafeInteger(id) || id <= 0)', 'if (false)'), invalid: true }
];
const root = mkdtempSync('/tmp/pallet-accounting-mutants-');
const results = [];
try {
  mkdirSync(`${root}/src`);
  for (const entry of readdirSync('src')) {
    if (entry !== 'return-netsuite.js') {
      symlinkSync(resolve('src', entry), `${root}/src/${entry}`);
    }
  }
  for (const name of ['node_modules', 'public', 'package.json']) {
    symlinkSync(resolve(name), `${root}/${name}`);
  }
  for (const mutant of mutants) {
    const body = mutant.source || source.slice(0, queryStart) + mutant.query + source.slice(queryEnd);
    assert.notEqual(body, source, `Mutation did not change source: ${mutant.name}`);
    const modulePath = `${root}/src/return-netsuite.js`;
    writeFileSync(modulePath, body);
    const env = { PALLET_ACCOUNTING_MODULE: pathToFileURL(modulePath).href };
    const whole = run(`mutant-${mutant.name}`, ['--test', testFile], { accepted: [1], env });
    assert.ok(whole.fail > 0);
    assert.doesNotMatch(whole.log, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    let propertyOnly = null;
    if (!mutant.invalid) {
      const property = run(`property-mutant-${mutant.name}`,
        ['--test', '--test-name-pattern=P4 property:', testFile], { accepted: [1], env });
      assert.equal(property.fail, 1);
      propertyOnly = true;
    }
    results.push({ name: mutant.name, killed: true, propertySuiteAlone: propertyOnly });
  }
  writeFileSync(`${root}/src/return-netsuite.js`, source);
  run('mutation-restored', ['--test', testFile],
    { env: { PALLET_ACCOUNTING_MODULE: pathToFileURL(`${root}/src/return-netsuite.js`).href } });
} finally {
  rmSync(root, { recursive: true, force: true });
}
writeFileSync(`${out}/mutations.json`, JSON.stringify(results, null, 2));
