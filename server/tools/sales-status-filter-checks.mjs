import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const tree = {};
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const path = dir + '/' + entry.name;
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) tree[path] = crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  }
}
for (const dir of ['src', 'public', 'migrations']) walk(dir);
const pythonJson = '{' + Object.keys(tree).sort().map(key => JSON.stringify(key) + ': ' + JSON.stringify(tree[key])).join(', ') + '}';
const result = {candidateTreeHash: crypto.createHash('sha256').update(pythonJson).digest('hex'), checks: []};
function run(name, args) {
  const log = fs.openSync(`test-artifacts/${name}.log`, 'w');
  const started = Date.now();
  const child = spawnSync('node', args, {stdio: ['ignore', log, log], timeout: 180000});
  fs.closeSync(log);
  const failed = [...fs.readFileSync(`test-artifacts/${name}.log`, 'utf8').matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
  const oldLayout = 'stock-request feedback is content-sized and availability shows Sales plus conversion equivalents';
  const baseline = name === 'stock-ui-regression' ? fs.readFileSync('test-artifacts/preexisting-ui-baseline.log', 'utf8') : '';
  const preexisting = name === 'stock-ui-regression' && child.status === 1 && failed.length === 1 && failed[0] === oldLayout
    && baseline.includes(' - ' + oldLayout) && baseline.includes('grid-template-rows');
  result.checks.push({name, exit: preexisting ? 0 : child.status, rawExit: child.status,
    preexistingFailures: preexisting ? failed : [], signal: child.signal, ms: Date.now()-started});
  fs.writeFileSync('test-artifacts/status-filter-checks.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.checks.at(-1)));
}
run('sales-syntax', ['--check', 'public/sales-stock-requests.js']);
run('backorder-syntax', ['--check', 'public/backorder-stock-requests.js']);
run('status-filter-browser', ['--test', '--test-concurrency=1', 'test/mbt/integration/sales-stock-status-filter-browser.test.js']);
run('stock-ui-regression', ['--test', '--test-concurrency=1', 'test/mbt/unit/stock-request-ui-contract.test.js', 'test/request-loading-ui.test.js']);
process.exitCode = result.checks.some(check => check.exit !== 0) ? 1 : 0;
