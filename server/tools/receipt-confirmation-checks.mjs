import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import { parse } from 'espree';
import { scanUnifiedDiff, scanPaths } from '../test/support/scan-diff-secrets.mjs';

const artifact = path.resolve('test-artifacts/receipt-confirmation');
const sources = ['public/operator.js', 'public/operator.html', 'public/service-worker.js', 'src/server.js', 'src/operator-receipt-recovery.js'];
const tests = ['test/mbt/unit/receipt-confirmation.test.js', 'test/mbt/integration/receipt-confirmation.test.js',
  'test/mbt/unit/receiving-posting-status.test.js', 'test/mbt/unit/operator-delivery-refresh.test.js',
  'test/mbt/unit/operator-posting-photo-client.test.js', 'test/mbt/unit/operator-receiving-return.test.js',
  'test/mbt/unit/operator-background-confirm.test.js', 'test/mbt/property/operator-netsuite-posting.property.test.js',
  'test/mbt/unit/operator-direct-orderline-client.test.js'];
const additions = ['src/operator-receipt-recovery.js', tests[0], tests[1], 'test/support/receipt-confirmation-client.mjs',
  'tools/receipt-confirmation-checks.mjs', 'tools/receipt-confirmation-browser.mjs', 'tools/receipt-confirmation-smoke.mjs',
  'tools/receipt-confirmation-adversarial.mjs'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes = () => Object.fromEntries(sources.map(file => [file, hash(file)]));
function run(args, name, environment = {}, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...environment } });
  assert.ok(!result.error, String(result.error));
  const log = result.stdout + result.stderr;
  fs.writeFileSync(`${artifact}/${name}.log`, log);
  return { status: result.status, log };
}
function save(name, value) {
  fs.writeFileSync(`${artifact}/${name}.json`, JSON.stringify(value, null, 2));
  console.log(JSON.stringify({ layer: name, ...value, baselineTypes: value.baselineTypes?.length,
    baselineLint: value.baselineLint?.length, diagnostics: value.diagnostics?.length, lint: value.lint?.length }));
}
function extras(current, baseline) {
  const remaining = [...baseline];
  return current.filter(item => {
    const index = remaining.indexOf(item);
    if (index < 0) return true;
    remaining.splice(index, 1); return false;
  });
}
const mode = process.argv[2];
if (mode === 'static') {
  const globals = Object.fromEntries(['window', 'document', 'navigator', 'self', 'caches', 'fetch', 'localStorage', 'sessionStorage',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'AbortController', 'AbortSignal', 'URL', 'URLSearchParams',
    'Blob', 'File', 'FileReader', 'FormData', 'Request', 'Image', 'ImageCapture', 'EventSource', 'HTMLElement', 'Element',
    'HTMLInputElement', 'HTMLImageElement', 'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'CustomEvent',
    'Event', 'performance', 'location', 'atob', 'btoa', 'crypto', 'process', 'console', 'Buffer', 'structuredClone',
    // Browser replay evaluates these actual client globals inside Playwright.
    'receivingOrderType', 'receiptOrder', 'receiptSubmitting', 'receiptResult', 'receiptPhotoDataUrls',
    'currentModule', 'receiptRequestId', 'operator', 'preparePhotoDataUrl', 'render', 'confirmReceipt',
    'prepareOperatorBackgroundPhotos', 'resumeOperatorBackgroundPhotos'].map(name => [name, 'writable']));
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ['**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }], 'no-unreachable': 'error', eqeqeq: 'error' } }] });
  const originalRoot = process.env.RECEIPT_CONFIRMATION_BASELINE_ROOT || `${artifact}/before`;
  const common = ['public/operator.js', 'public/service-worker.js', 'src/server.js', ...tests.slice(2).filter(file => fs.existsSync(`${originalRoot}/${file}`))];
  const lintFor = async (root, files) => {
    const messages = [];
    for (const file of files) {
      const rows = await eslint.lintText(fs.readFileSync(`${root}/${file}`, 'utf8'), { filePath: path.resolve(file) });
      for (const row of rows) for (const message of row.messages) messages.push(`${file}: ${message.ruleId} ${message.message}`);
    }
    return messages.sort();
  };
  const baselineLint = await lintFor(originalRoot, common);
  const lint = await lintFor(process.cwd(), [...common, ...additions]);
  const typed = root => {
    const result = run([path.resolve('node_modules/typescript/bin/tsc'), '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck',
      '--module', 'nodenext', '--target', 'ES2022', 'public/operator.js', 'src/server.js'], root === originalRoot ? 'baseline-types' : 'types', {}, root);
    const diagnostics = result.log.split('\n').filter(line => /error TS\d+/u.test(line))
      .map(line => line.replace(/\(\d+,\d+\)/u, '(line,column)')).sort();
    assert.ok(diagnostics.length || result.status === 0, 'Type checker failed to execute');
    return diagnostics;
  };
  const baselineTypes = typed(originalRoot), diagnostics = typed(process.cwd());
  const newLint = extras(lint, baselineLint), newTypes = extras(diagnostics, baselineTypes);
  for (const file of new Set([...common, ...additions])) assert.equal(run(['--check', file], `syntax-${path.basename(file)}`).status, 0);
  const diff = fs.readFileSync(`${artifact}/changes.patch`, 'utf8');
  const secrets = [...scanUnifiedDiff(diff), ...await scanPaths(additions)];
  for (const file of ['package.json', 'package-lock.json']) assert.equal(hash(file), hash(`${originalRoot}/${file}`));
  save('static', { baselineLint, baselineTypes, lint, diagnostics, newLint, newTypes, secrets, dependenciesChanged: false, sources: hashes(), node: process.version });
  assert.deepEqual(newLint, []); assert.deepEqual(newTypes, []); assert.deepEqual(secrets, []);
} else if (mode === 'focused' || mode === 'health') {
  // Node sorts multiple file arguments. Separate invocations enforce a different
  // file order while retaining the same database to detect fixture interference.
  const selected = mode === 'health' ? [...tests].sort((a, b) =>
    crypto.createHash('sha256').update('1401278:' + a).digest('hex').localeCompare(
      crypto.createHash('sha256').update('1401278:' + b).digest('hex'))) : tests;
  const batches = mode === 'health' ? selected.map(file => [file]) : [selected];
  const counts = [];
  for (const [index, batch] of batches.entries()) {
    const result = run(['--test', '--test-concurrency=1', ...batch], batches.length === 1 ? mode : `${mode}-${index}`,
      mode === 'focused' ? { NODE_V8_COVERAGE: `${artifact}/v8` } : {});
    assert.equal(result.status, 0, result.log);
    counts.push(...result.log.split('\n').filter(line => /^# (tests|pass|fail|skipped) /u.test(line)));
  }
  save(mode, { counts, fileOrder: selected, orderSeed: mode === 'health' ? 1401278 : null, sources: hashes() });
} else if (mode === 'mutations') {
  const client = fs.readFileSync('public/operator.js', 'utf8');
  const backend = fs.readFileSync('src/operator-receipt-recovery.js', 'utf8');
  const mutations = [
    ['legacy_recovery_disabled', client, 'if (saved === null) return false;', 'return false;', 'client'],
    ['wrong_menu_type', client, 'order_type: saved?.orderType || receivingOrderType,', 'order_type: receivingOrderType,', 'client'],
    ['late_recovery_replaces_order', client, 'if (receiptOrder !== order || receiptRequestId !== requestId) return;', '', 'client'],
    ['update_interrupts_receipt', client, 'receiptServiceWorkerReloadPending = true;\n    return;', 'window.location.reload();\n    return;', 'client'],
    ['hidden_known_IR', client, 'return id ? [{ id, ref: step.transactionRef || step.observedTransaction?.tranId || String(id) }] : [];', 'return [];', 'client'],
    ['cross_operator_receipt', backend, 'AND command.actor_operator_id=$2 AND command.canonical_location_id=$3', 'AND $2::uuid IS NOT NULL AND command.canonical_location_id=$3', 'backend'],
    ['wrong_yard_receipt', backend, 'AND command.actor_operator_id=$2 AND command.canonical_location_id=$3', 'AND command.actor_operator_id=$2 AND $3::integer IS NOT NULL', 'backend'],
    ['older_success_replaces_failure', backend, "WHERE command.function_key='receiving' AND command.transaction_type='IR'", "WHERE command.status='completed' AND command.function_key='receiving' AND command.transaction_type='IR'", 'backend'],
  ];
  const evidence = [];
  for (const [name, original, before, after, kind] of mutations) {
    assert.equal(original.split(before).length, 2, `Mutation must have a unique target: ${name}`);
    const file = `/tmp/receipt-confirmation-${name}.mjs`;
    let source = original.replace(before, after);
    if (kind === 'backend') source = source.replaceAll("from './", "from 'file:///app/src/")
      .replace("from 'express'", `from '${import.meta.resolve('express')}'`);
    fs.writeFileSync(file, source);
    const environment = kind === 'client' ? { RECEIPT_CONFIRMATION_SOURCE_FILE: file } : { RECEIPT_CONFIRMATION_BACKEND: `file://${file}` };
    const target = kind === 'client' ? tests[0] : tests[1];
    const result = run(['--test', target], `mutant-${name}`, environment);
    assert.equal(result.status, 1, `Mutant survived: ${name}`);
    assert.match(result.log, /ERR_ASSERTION|Property failed/u);
    assert.doesNotMatch(result.log, /SyntaxError|ERR_MODULE_NOT_FOUND/u);
    const property = run(['--test', '--test-name-pattern=^property:', target], `property-mutant-${name}`, environment);
    assert.doesNotMatch(property.log, /SyntaxError|ERR_MODULE_NOT_FOUND/u);
    evidence.push({ name, killed: true, propertyKilled: property.status === 1 });
    fs.unlinkSync(file);
  }
  assert.equal(fs.readFileSync('public/operator.js', 'utf8'), client);
  assert.equal(fs.readFileSync('src/operator-receipt-recovery.js', 'utf8'), backend);
  save('mutations', { evidence, sources: hashes() });
} else if (mode === 'coverage') {
  const manifest = JSON.parse(fs.readFileSync(`${artifact}/changes.json`, 'utf8'));
  const node = fs.readdirSync(`${artifact}/v8`).filter(file => file.endsWith('.json'))
    .flatMap(file => JSON.parse(fs.readFileSync(`${artifact}/v8/${file}`)).result);
  const browser = fs.readdirSync(`${artifact}/browser`).filter(file => file.endsWith('-coverage.json'))
    .flatMap(file => JSON.parse(fs.readFileSync(`${artifact}/browser/${file}`)));
  const covered = (entries, offset) => entries.some(entry => {
    const ranges = entry.functions.flatMap(fn => fn.ranges).filter(range => range.startOffset <= offset && offset < range.endOffset)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    return ranges[0]?.count > 0;
  });
  const files = {};
  for (const [file, info] of Object.entries(manifest)) {
    if (!file.endsWith('.js')) continue;
    assert.equal(hash(file), info.hash);
    const source = fs.readFileSync(file, 'utf8');
    const changed = new Set(info.lines);
    const declarations = parse(source, { ecmaVersion: 'latest', sourceType: file.startsWith('public/') ? 'script' : 'module', range: true }).body
      .filter(item => item.type === 'FunctionDeclaration');
    const nodeEntries = node.filter(entry => entry.url === `file:///app/${file}` || entry.url === `/app/${file}`);
    const browserEntries = browser.filter(entry => entry.source === source);
    const executed = [], missing = [];
    let offset = 0;
    for (const [index, line] of source.split('\n').entries()) {
      const token = line.trim();
      if (changed.has(index + 1) && token && !/^(?:\/\/|\/\*|\*)/u.test(token) && !/^[{}[\](),;]+$/u.test(token)) {
        const position = offset + line.search(/\S/u);
        const nodeEligible = file !== 'public/operator.js' || declarations.some(item => item.start <= position && position < item.end);
        ((nodeEligible && covered(nodeEntries, position)) || covered(browserEntries, position) ? executed : missing).push(index + 1);
      }
      offset += line.length + 1;
    }
    files[file] = { executed: executed.length, total: executed.length + missing.length, missing };
  }
  save('coverage', { files, sources: hashes() });
  for (const file of Object.values(files)) assert.deepEqual(file.missing, []);
} else if (mode === 'full-comparison') {
  const parseLog = file => {
    const text = fs.readFileSync(`${artifact}/${file}-full.log`, 'utf8');
    assert.match(text, /Isolated MBT main run (?:failed|passed)/u);
    const failures = [...text.matchAll(/^✖ (.+?) \([\d.]+ms\)$/gmu)].map(match => match[1]).sort();
    const fileLine = text.split('\n').find(line => line.startsWith('Isolated MBT main run '));
    const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(key => [key,
      [...text.matchAll(new RegExp(`^ℹ ${key} (\\d+)`, 'gmu'))].reduce((sum, match) => sum + Number(match[1]), 0)]));
    return { failures, fileLine, counts };
  };
  const baseline = parseLog('baseline'), candidate = parseLog('candidate');
  const newFailures = extras(candidate.failures, baseline.failures);
  save('full-comparison', { baseline, candidate, newFailures, sources: hashes() });
  assert.deepEqual(newFailures, []);
} else throw new Error('Unknown receipt confirmation check mode');
