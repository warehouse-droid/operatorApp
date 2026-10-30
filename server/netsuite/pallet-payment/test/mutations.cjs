const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = '/artifacts/mutations';
fs.mkdirSync(root, { recursive: true });
const mutations = [
  ['ppa_core.js', 'Math.floor(group.funds / rate)', 'Math.ceil(group.funds / rate)', 'cash-round-up'],
  ['ppa_core.js', "group.method === '1' ? line.net : line.gross", 'line.net', 'remove-noncash-tax'],
  ['ppa_core.js', 'allocation.available -= qty;', 'allocation.available -= 0;', 'forget-refund-deduction'],
  ['ppa_core.js', 'allocation.last4 === parsed.last4', 'true', 'ignore-card-match'],
  ['ppa_service.js', 'if (dryRun) {', 'if (false) {', 'dry-run-writes'],
  ['ppa_service.js', 'io.invalidate(customer);\n      throw error;', 'throw error;', 'leave-partial-publication'],
  ['ppa_netsuite.js', "source: String(source.id)", 'source: String(meta.id)', 'deposit-double-source'],
  ['ppa_netsuite.js', "rate: row.rate / 100", 'rate: row.rate', 'persist-cents-as-dollars'],
  ['ppa_netsuite.js', "amount: row.amount / 100", 'amount: row.amount', 'refund-cents-as-dollars'],
  ['ppa_netsuite.js', 'doc.mixed = true;', 'doc.mixed = false;', 'treat-goods-credit-as-pallets'],
  ['ppa_core.js', "refund.method === '1' && refund.posted && used === 0", "false && refund.posted && used === 0", 'reject-known-full-cash-refund'],
  ['ppa_core.js', "refund.amount === integer(credit.qty * credit.gross, 'CREDIT_GROSS_AMOUNT', 1)", 'true', 'infer-quantity-from-partial-cash-refund'],
  ['ppa_refresh_queue.js', ", 'and', ['internalid', 'anyof', ids]", '', 'clear-later-events'],
  ['ppa_refresh_queue.js', "[F.customer, 'anyof', customerId]", "['isinactive', 'is', 'F']", 'clear-other-customer-events'],
  ['ppa_refresh_queue.js', 'minute() + config.queueRetryMinutes', 'minute()', 'retry-failed-event-immediately'],
  ['ppa_refresh_queue.js', 'ids.length > config.queueBatchSize', 'false', 'unbounded-acknowledgement'],
  ['ppa_refresh_queue.js', 'runtime.getCurrentScript().deploymentId !== config.writerDeployment', 'false', 'allow-second-queue-writer'],
  ['ppa_watch_ue.js', '[context.oldRecord, context.newRecord]', '[context.newRecord]', 'forget-previous-customer'],
  ['ppa_watch_ue.js', "String(value(identified, 'externalid') || '').startsWith('PRA1-')", 'false', 'requeue-generated-refunds'],
  ['ppa_rebuild_mr.js', 'queueOnly() && !dryRun', 'queueOnly()', 'preview-acknowledges-queue'],
  ['ppa_netsuite.js', 'new Set([...fromTransactions, ...fromLedger])', 'new Set(fromTransactions)', 'omit-existing-ledger-customers'],
  ['ppa_netsuite.js', 'paged.pageRanges.flatMap(page => paged.fetch({ index: page.index }).data.map(row => id(row.getValue(column))))',
    'paged.pageRanges.slice(0, 1).flatMap(page => paged.fetch({ index: page.index }).data.map(row => id(row.getValue(column))))', 'omit-later-customer-pages'],
  ['ppa_netsuite.js', '[...new Set([...fromTransactions, ...fromLedger])]', '[...fromTransactions, ...fromLedger]', 'duplicate-discovered-customers']
];
let killed = 0;
let propertyKilled = 0;
for (const [file, from, to, label] of mutations) {
  const dir = path.join(root, label);
  fs.cpSync('/work', dir, { recursive: true });
  const filename = path.join(dir, file);
  const source = fs.readFileSync(filename, 'utf8');
  assert.ok(source.includes(from), `Mutation anchor missing: ${label}`);
  fs.writeFileSync(filename, source.replace(from, to));
  const r = spawnSync('node', ['--test', 'test/core.test.cjs', 'test/service.test.cjs', 'test/adapter.test.cjs', 'test/refresh.test.cjs'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_V8_COVERAGE: path.join(root, 'coverage') }, timeout: 30000
  });
  assert.ok(r.status !== null && r.status !== 0 && r.stdout.includes('not ok'), `Surviving or invalid mutant: ${label}\n${r.stderr}`);
  killed += 1;
  if ((file === 'ppa_core.js' || ['clear-later-events', 'clear-other-customer-events', 'retry-failed-event-immediately'].includes(label)) && fs.existsSync('/artifacts/toolchain/node_modules/fast-check')) {
    const property = spawnSync('node', ['test/properties.cjs'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.ok(property.status !== null && property.status !== 0 && property.stderr.includes('Property failed'), `Property survivor: ${label}`);
    propertyKilled += 1;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`Mutation checks: ${killed}/${mutations.length} plausible bugs detected.`);
if (propertyKilled) { console.log(`Property-only mutation checks: ${propertyKilled}/9 calculation and queue bugs detected.`); }
