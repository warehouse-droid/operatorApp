import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import { parse } from 'espree';
import { scanPaths } from '../test/support/scan-diff-secrets.mjs';

const artifact = 'test-artifacts/receiving-posting-status';
fs.mkdirSync(artifact, { recursive: true });
const sources = ['public/operator.js', 'public/operator.html', 'public/service-worker.js'];
const tests = ['test/mbt/unit/receiving-posting-status.test.js', 'test/mbt/unit/operator-posting-photo-client.test.js',
  'test/mbt/unit/operator-direct-orderline-client.test.js', 'test/mbt/unit/operator-receiving-return.test.js',
  'test/mbt/unit/operator-background-confirm.test.js', 'test/mbt/unit/operator-netsuite-posting-service.red.test.js',
  'test/mbt/unit/operator-netsuite-posting-runtime-adapters.red.test.js', 'test/mbt/unit/operator-receiving-quantity-ui.test.js',
  'test/mbt/property/operator-netsuite-posting.property.test.js'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes = () => Object.fromEntries(sources.map(file => [file, hash(file)]));
function run(args, name, environment = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000,
    maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...environment } });
  assert.ok(!result.error, String(result.error));
  const log = result.stdout + result.stderr;
  fs.writeFileSync(`${artifact}/${name}.log`, log);
  return { status: result.status, log };
}
function save(name, value) {
  fs.writeFileSync(`${artifact}/${name}.json`, JSON.stringify(value, null, 2));
  console.log(JSON.stringify(value));
}
const mode = process.argv[2];
if (mode === 'static') {
  const files = [...sources.filter(file => file.endsWith('.js')), tests[0],
    'tools/receiving-posting-status-checks.mjs', 'tools/receiving-posting-status-browser.mjs'];
  for (const file of files) assert.equal(run(['--check', file], `syntax-${file.split('/').at(-1)}`).status, 0);
  const globals = Object.fromEntries(['window', 'document', 'navigator', 'self', 'caches', 'fetch', 'localStorage', 'sessionStorage',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'AbortController', 'AbortSignal', 'URL', 'URLSearchParams',
    'Blob', 'File', 'FileReader', 'FormData', 'Request', 'Image', 'ImageCapture', 'EventSource', 'HTMLElement', 'Element',
    'HTMLInputElement', 'HTMLImageElement', 'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'CustomEvent',
    'Event', 'performance', 'location', 'atob', 'btoa', 'crypto', 'process', 'console', 'Buffer', 'structuredClone'].map(name => [name, 'readonly']));
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ['**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'error', 'no-unreachable': 'error', eqeqeq: 'error' } }] });
  const lint = (await eslint.lintFiles(files)).flatMap(row => row.messages.map(message =>
    `${row.filePath.replace('/app/', '')}: ${message.ruleId} ${message.message}`)).sort();
  const typed = run(['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck',
    '--module', 'nodenext', '--target', 'ES2022', 'public/operator.js'], 'types');
  const diagnostics = typed.log.split('\n').filter(line => /error TS\d+/u.test(line))
    .map(line => line.replace(/\(\d+,\d+\)/u, '(line,column)')).sort();
  assert.ok(diagnostics.length || typed.status === 0, 'Type checker did not execute');
  assert.deepEqual(await scanPaths(files), []);
  save('static', { lint, diagnostics, sources: hashes(), node: process.version });
} else if (mode === 'focused' || mode === 'health') {
  const selected = mode === 'health' ? [...tests].reverse() : tests;
  const result = run(['--test', '--test-concurrency=1', ...selected], mode);
  assert.equal(result.status, 0, result.log);
  save(mode, { counts: result.log.split('\n').filter(line => /^# (tests|pass|fail|skipped) /u.test(line)), sources: hashes() });
} else if (mode === 'mutations') {
  const original = fs.readFileSync('public/operator.js', 'utf8');
  const mutations = {
    repost_pending: ['if (receiptOrder.posting?.receiveBlocked) return refreshReceiptPostingStatus();', ''],
    hide_receipt: ['return id ? [{ id, ref: step.transactionRef || step.observedTransaction?.tranId || String(id) }] : [];', 'return [];'],
    premature_completion: ['if (job.status === "completed") {\n    receiptResult =', 'if (["completed", "attention"].includes(job.status)) {\n    receiptResult ='],
    stale_result: ['if (receiptOrder === order && receiptRequestId === requestId) observeReceiptPostingJob(job);', 'receiptResult = job.result?.localFinalization || job.result;'],
    ignore_submission_identity: ['const isCurrent = () => receiptOrder === activeOrder && receiptRequestId === requestId;', 'const isCurrent = () => true;'],
    forget_job: ['if (posting) window.localStorage?.setItem(key, JSON.stringify({\n      requestId: receiptRequestId', 'if (false) window.localStorage?.setItem(key, JSON.stringify({\n      requestId: receiptRequestId'],
    reject_is_pending: ['receiptOrder.posting?.status === "submitting" && error.status >= 400', 'false && error.status >= 400'],
    journal_local_only: ['if (deferPhotos) rememberReceiptPosting({ jobId: receiptRequestId', 'if (true) rememberReceiptPosting({ jobId: receiptRequestId']
  };
  const evidence = [];
  for (const [name, [before, after]] of Object.entries(mutations)) {
    assert.equal(original.split(before).length, 2, `Non-unique mutation ${name}`);
    const candidate = `/tmp/receiving-posting-${name}.js`;
    fs.writeFileSync(candidate, original.replace(before, after));
    const result = run(['--test', tests[0]], `mutant-${name}`, { RECEIPT_STATUS_SOURCE: candidate });
    assert.equal(result.status, 1, `${name} survived`);
    assert.match(result.log, /ERR_ASSERTION|Property failed/u);
    assert.doesNotMatch(result.log, /SyntaxError|ERR_MODULE_NOT_FOUND/u);
    const property = run(['--test', '--test-name-pattern=^property:', tests[0]], `property-mutant-${name}`, { RECEIPT_STATUS_SOURCE: candidate });
    assert.doesNotMatch(property.log, /SyntaxError|ERR_MODULE_NOT_FOUND/u);
    evidence.push({ name, killed: true, propertyKilled: property.status === 1 });
    fs.unlinkSync(candidate);
  }
  assert.equal(fs.readFileSync('public/operator.js', 'utf8'), original);
  save('mutations', { evidence, sources: hashes() });
} else if (mode === 'coverage') {
  const source = fs.readFileSync('public/operator.js', 'utf8');
  const manifest = JSON.parse(fs.readFileSync('test/support/receiving-posting-status-changes.json', 'utf8'));
  assert.equal(hash('public/operator.js'), manifest.sourceHash, 'Changed-line manifest is stale');
  const changed = new Set(manifest.changedLines);
  const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body
    .filter(node => node.type === 'FunctionDeclaration');
  const browser = JSON.parse(fs.readFileSync(`${artifact}/browser-coverage.json`, 'utf8'));
  const coverageDirectory = process.env.RECEIPT_STATUS_COVERAGE || `${artifact}/v8`;
  const unit = fs.readdirSync(coverageDirectory).filter(file => file.endsWith('.json'))
    .flatMap(file => JSON.parse(fs.readFileSync(`${coverageDirectory}/${file}`)).result)
    .filter(entry => entry.url.endsWith('/public/operator.js'));
  const covered = (entries, offset) => entries.some(entry => {
    const ranges = entry.functions.flatMap(fn => fn.ranges).filter(range => range.startOffset <= offset && offset < range.endOffset)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    return ranges[0]?.count > 0;
  });
  const executed = [], missing = [];
  let offset = 0;
  for (const [index, line] of source.split('\n').entries()) {
    const token = line.trim();
    if (changed.has(index + 1) && token && !/^(?:\/\/|\/\*|\*)/u.test(token) && !/^[{}[\](),;]+$/u.test(token)) {
      const position = offset + line.search(/\S/u);
      const inDeclaration = declarations.some(node => node.start <= position && position < node.end);
      (covered(browser, position) || (inDeclaration && covered(unit, position)) ? executed : missing).push(index + 1);
    }
    offset += line.length + 1;
  }
  save('coverage', { executed: executed.length, total: executed.length + missing.length, missing, sources: hashes() });
  assert.deepEqual(missing, [], 'Changed lines lack execution evidence');
} else {
  throw new Error('Use static, focused, health, or mutations');
}
