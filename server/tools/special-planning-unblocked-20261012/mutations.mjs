import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';

export async function runMutations({ snapshot, tests, reset, runtime, out, primary }) {
  const results = [];
  const task = 'tools/special-planning-unblocked-20261012';
  const mutations = [
    { name: 'restore-special-request-blockers', file: runtime[0], tests: [primary[0]],
      pattern: 'Special request approval|does not query', change(source) {
        const baseline = readFileSync(`${task}/baseline/${runtime[0]}`, 'utf8');
        const start = baseline.indexOf('export async function assertSpecialStockHandoffPlanning(');
        const end = baseline.indexOf('\nfunction collectPlanOrderRefs(', start);
        const from = source.indexOf('export async function assertSpecialStockHandoffPlanning(');
        const to = source.indexOf('\nfunction collectPlanOrderRefs(', from);
        return "import { specialPlannedOrderRefs } from './special-stock-planning.js';\n"
          + source.slice(0, from) + baseline.slice(start, end) + source.slice(to);
      } },
    { name: 'packing-review-still-blocks', file: runtime[1], tests: [primary[1], primary[2]],
      pattern: 'packing-only reconciliation|packing Review allows', change(source) {
        const before = 'const packingReviewOnly = isSalesPackingReconciliationReview(row);';
        assert.ok(source.includes(before)); return source.replace(before, 'const packingReviewOnly = false;');
      } },
    { name: 'all-reconciliation-reviews-exempt', file: runtime[1], tests: [primary[1]],
      pattern: 'unknown, mixed', change(source) {
        const before = 'return refs.some(ref => reason === `unsubmitted operator packing on ${ref}.`\n    || reason === `sales order family reconciliation is blocked by an active operator packing draft on ${ref}.`);';
        assert.ok(source.includes(before)); return source.replace(before, 'return true;');
      } },
    { name: 'omit-authoritative-packing-reason', file: runtime[2], tests: [primary[3]],
      pattern: 'packed and packing-only Review', change(source) {
        const before = 'state.application_status, state.reconciliation_status, state.reconciliation_reason,';
        assert.ok(source.includes(before)); return source.replace(before, 'state.application_status, state.reconciliation_status,');
      } },
    { name: 'packing-and-loaded-split-guards-removed', file: 'public/dispatch.js', tests: [primary[2]],
      pattern: 'packing Review allows|local loading', change(source) {
        const packed = 'if (order.operatorStatus === "packed")';
        const loaded = 'if (order.localYardOrderStatus === "Loaded")';
        assert.ok(source.includes(packed) && source.includes(loaded));
        return source.replace(packed, 'if (false)').replace(loaded, 'if (false)');
      } },
    { name: 'cached-packing-review-still-blocks', file: runtime[1],
      tests: ['test/dispatch/integration/dispatch-packed-group-review.test.js'],
      pattern: 'cached packing-only', change(source) {
        const before = 'const planningReviewIgnored = state?.packingReviewOnly || cachedGroupReview;';
        assert.ok(source.includes(before)); return source.replace(before, 'const planningReviewIgnored = state?.packingReviewOnly;');
      } },
    { name: 'preparing-child-blocks-group', file: runtime[0], tests: [primary[3]],
      pattern: 'grouped sales deliveries', change(source) {
        const before = 'const calculationReview = ["review", "missing", "error"].includes(calculationReconciliationStatus);';
        assert.ok(source.includes(before)); return source.replace(before,
          'const calculationReview = row.operator_status === "preparing" || ["review", "missing", "error"].includes(calculationReconciliationStatus);');
      } }
  ];
  for (const mutation of mutations) {
    const root = snapshot();
    try {
      if (mutation.file.startsWith('public/')) {
        rmSync(`${root}/public`); cpSync('public', `${root}/public`, { recursive: true });
      }
      const path = `${root}/${mutation.file}`;
      writeFileSync(path, mutation.change(readFileSync(path, 'utf8')));
      reset();
      const result = tests('mutant-' + mutation.name, mutation.tests, { cwd: root, pattern: mutation.pattern });
      const killed = result.exit !== 0 && result.fail > 0;
      results.push({ name: mutation.name, killed, exit: result.exit, failures: result.failures });
      writeFileSync(`${out}/mutations.json`, JSON.stringify(results, null, 2) + '\n');
      assert.equal(killed, true, mutation.name + ' survived');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify({ mutationsKilled: results.length, mutations: results.length }));
}
