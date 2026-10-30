import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, cpSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
import coverage from 'istanbul-lib-coverage';
import base from '../eslint.mbt.config.js';
import {mutants, priorSource} from '../test/support/custom-order-movement-yard-mutations.mjs';

const out = 'test-artifacts/custom-order-movement-yard';
mkdirSync(out, {recursive:true});
const runtime = 'src/yard-movement-repository.js';
const focused = 'test/mbt/integration/custom-order-movement-yard.test.js';
const loader = 'test/support/custom-order-movement-yard-mutations.mjs';
const tests = [focused, 'test/yard-movement-performance.test.js', 'test/yard-movement-requests.test.js',
  'test/mbt/integration/yard-movement-po-search.test.js', 'test/mbt/integration/movement-document-history.test.js'];
const source = readFileSync(runtime, 'utf8');
const counts = text => Object.fromEntries([...text.matchAll(/^# (tests|pass|fail|skipped|cancelled) (\d+)$/gmu)].map(m => [m[1], Number(m[2])]));
function run(name, args, {env={}, failure=false, timeout=180000}={}) {
  const result = spawnSync(process.execPath, args, {env:{...process.env,...env},encoding:'utf8',timeout,maxBuffer:30*1024*1024});
  const output = (result.stdout || '') + (result.stderr || '');
  writeFileSync(`${out}/${name}.log`, output);
  console.log(JSON.stringify({stage:name,exit:result.status,...counts(output)}));
  if (!failure) assert.equal(result.status, 0, output.slice(-14000));
  return {...result,output};
}

const old = run('prior-behavior', ['--loader',`./${loader}`,'--test',focused], {env:{CUSTOM_YARD_MUTANT:'prior'},failure:true});
assert.equal(counts(old.output).fail, 5, old.output);
assert.equal(counts(old.output).pass, 3);
const regression = run('regressions', ['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',`--include=${runtime}`,
  `--temp-directory=${out}/v8`,`--report-dir=${out}/coverage`,'--reporter=json',
  process.execPath,'--test','--test-concurrency=1',...tests]);
for (const harness of ['yard-movement-integration-harness','sales-order-reload-yard-history-harness']) {
  run(harness, [`src/${harness}.js`]);
}
const customHarness = 'src/dispatch-custom-order-harness.js';
const priorHarness = run('custom-harness-before', ['--loader',`./${loader}`,customHarness], {env:{CUSTOM_YARD_MUTANT:'prior'},failure:true});
const currentHarness = run('custom-harness-after', [customHarness], {failure:true});
const expectedHarnessFailure = /expected: \/includeCustom[^\n]+/u;
assert.equal(priorHarness.status, 1);
assert.equal(currentHarness.status, 1);
assert(priorHarness.output.includes('AssertionError [ERR_ASSERTION]'));
assert(currentHarness.output.includes('AssertionError [ERR_ASSERTION]'));
assert(priorHarness.output.match(expectedHarnessFailure));
assert.deepEqual(currentHarness.output.match(expectedHarnessFailure)?.[0], priorHarness.output.match(expectedHarnessFailure)[0]);
const baselineFailure = priorHarness.output.match(/AssertionError \[ERR_ASSERTION\]:[^\n]+/u)?.[0];
assert.equal(currentHarness.output.match(/AssertionError \[ERR_ASSERTION\]:[^\n]+/u)?.[0],baselineFailure);
const mutationResults = [];
for (const [name, [,,pattern]] of Object.entries(mutants)) {
  const result = run(`mutant-${name}`, ['--loader',`./${loader}`,'--test',`--test-name-pattern=${pattern}`,focused],
    {env:{CUSTOM_YARD_MUTANT:name},failure:true});
  assert(result.status !== 0 && counts(result.output).fail > 0 && result.output.includes(`CUSTOM_YARD_MUTATION:${name}`), result.output);
  const property = run(`property-mutant-${name}`, ['--loader',`./${loader}`,'--test','--test-name-pattern=Y2:',focused],
    {env:{CUSTOM_YARD_MUTANT:name},failure:true});
  mutationResults.push({name,killed:true,propertyKilled:property.status !== 0 && counts(property.output).fail > 0});
}
run('reordered', ['--test','--test-concurrency=1',...tests.toReversed()]);

const rules = Object.fromEntries(['eqeqeq','no-constant-condition','no-duplicate-imports','no-implicit-coercion','no-shadow',
  'no-undef','no-unreachable','no-unused-vars','no-useless-catch','no-var','prefer-const'].map(name => [name,base[1].rules[name]]));
const eslint = new ESLint({overrideConfigFile:true,overrideConfig:[{files:['**/*.js','**/*.mjs'],languageOptions:base[1].languageOptions,rules}]});
const tally = messages => messages.reduce((result, key) => {result[key]=(result[key]||0)+1;return result;}, {});
const added = (before, after) => Object.fromEntries(Object.entries(after).filter(([key,n]) => n > (before[key]||0)));
const lint = async text => tally((await eslint.lintText(text,{filePath:runtime}))[0].messages.map(m => `${m.ruleId}: ${m.message}`));
const lintBefore = await lint(priorSource(source)), lintAfter = await lint(source);
assert.deepEqual(added(lintBefore,lintAfter), {});
const tooling = [focused, loader, 'tools/custom-order-movement-yard-checks.mjs'];
for (const file of [runtime,...tooling]) run(`syntax-${file.split('/').at(-1)}`, ['--check',file]);
const lintTools = await eslint.lintFiles(tooling);
assert.equal(lintTools.reduce((sum,row) => sum+row.errorCount+row.warningCount,0),0,JSON.stringify(lintTools.flatMap(r => r.messages)));

const beforeRoot = `${out}/type-before`;
cpSync('src',`${beforeRoot}/src`,{recursive:true});
cpSync('package.json',`${beforeRoot}/package.json`);
writeFileSync(`${beforeRoot}/${runtime}`, priorSource(source));
function types(file, label) {
  const result = run(`types-${label}`, ['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--skipLibCheck',
    '--target','ES2022','--module','NodeNext','--pretty','false',file], {failure:true});
  assert([0,1,2].includes(result.status), result.output);
  return tally(result.output.split('\n').filter(Boolean).map(line => line.replaceAll(`${beforeRoot}/`,'').replace(/\(\d+,\d+\)/gu,'')));
}
const typesBefore=types(`${beforeRoot}/${runtime}`,'before'), typesAfter=types(runtime,'after');
assert.deepEqual(added(typesBefore,typesAfter), {});
const map=coverage.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)));
const lineCoverage=map.fileCoverageFor(`/app/${runtime}`).getLineCoverage();
const lines=source.split('\n'), start=lines.findIndex(line => line.startsWith('function customOrderYardLocationIdSql'));
const end=lines.findIndex((line,index) => index>start && line.startsWith('function receivedSalesSql'));
const changed=lines.flatMap((line,index) => ((index>=start && index<end) || line.includes('${customOrderYardLocationIdSql("o.pickup_location")}'))
  && line.trim() && !/^\s*(?:\/\/|\/\*|\*|[{}();,]+\s*$)/u.test(line) ? [index+1] : []);
assert(changed.length > 0);
assert.deepEqual(changed.filter(line => !lineCoverage[line]), []);
run('secrets', ['test/support/scan-diff-secrets.mjs',runtime,...tooling]);
const hash = value => createHash('sha256').update(value).digest('hex');
const evidence = {passed:true,node:process.version,tests:counts(regression.output),mutants:mutationResults,
  baselineFailure,
  changedCoverage:{covered:changed.length,total:changed.length},
  lint:{baseline:lintBefore,current:lintAfter,new:0,toolingErrors:0},
  types:{baseline:Object.values(typesBefore).reduce((a,b)=>a+b,0),current:Object.values(typesAfter).reduce((a,b)=>a+b,0),new:0},
  versions:Object.fromEntries(['fast-check','c8','eslint','typescript'].map(name => [name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version])),
  hashes:Object.fromEntries([runtime,...tests,...tooling.slice(1)].map(file => [file,hash(readFileSync(file))]))};
writeFileSync(`${out}/evidence.json`,JSON.stringify(evidence,null,2));
console.log('CUSTOM_YARD_EVIDENCE '+JSON.stringify(evidence));
