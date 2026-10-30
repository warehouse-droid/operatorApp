import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const original = readFileSync('src/operator-load-quantity.js', 'utf8');
const target = '/app/test-artifacts/load-completion-rounding/mutant.js';
const mutations = [
  ['drop rounding', 'Math.round(value * 100) / 100', 'value'],
  ['round down', 'Math.round(value * 100) / 100', 'Math.floor(value * 100) / 100'],
  ['round non-SQFT', "String(unit || '').trim().toUpperCase() === 'SQFT'", 'true'],
  ['floor whole counts', '? upper : lower;', '? lower : lower;'],
  ['round conversion first', 'consumed + upper * conversion, unit', 'consumed + upper * (Math.round(conversion * 100) / 100), unit'],
  ['allow a different cent', 'upperSales === operatorRoundedSalesQuantity(loaded, unit)',
    'Math.abs(upperSales - operatorRoundedSalesQuantity(loaded, unit)) <= 0.011']
];
let killed = 0;
try {
  for (const [name, before, after] of mutations) {
    assert.equal(original.split(before).length, 2, `${name}: unique mutation target`);
    writeFileSync(target, original.replace(before, after));
    const result = spawnSync(process.execPath, ['--import', './test/support/load-completion-rounding-mutation-loader.mjs',
      '--test', '--test-reporter=spec', '--test-name-pattern=property', 'test/mbt/unit/load-completion-rounding.test.js'],
    { encoding: 'utf8', env: { ...process.env, LOAD_ROUNDING_MUTANT: target } });
    assert.notEqual(result.status, 0, `Mutant survived: ${name}`);
    assert.match(`${result.stdout}${result.stderr}`, /Property failed/, `Mutant must fail a behavioral property: ${name}`);
    console.log(`KILLED ${name}`);
    killed += 1;
  }
} finally { rmSync(target, { force: true }); }
console.log(`${killed}/${mutations.length} mutants killed by properties; original files unchanged`);
