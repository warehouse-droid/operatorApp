import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync('/tmp/dispatch-freshness-mutants-');
const property = 'test/dispatch/frontend/dispatch-freshness-races.test.js';
const server = 'test/dispatch/unit/dispatch-freshness-server.test.js';
const browser = 'test/dispatch/frontend/dispatch-freshness.browser.test.mjs';
const mutants = [
  ['stale-generation', 'public/dispatch.js', 'token.generation === localPlanGeneration', 'true', property],
  ['out-of-order-response', 'public/dispatch.js', 'dispatchOrderReadRequests.get(key) !== token', 'false', property],
  ['discard-hydrated-cargo', 'public/dispatch.js', 'fresh.catalogDetailSignature === existing.catalogDetailSignature', 'false', property],
  ['reuse-old-server-read', 'src/server.js', 'if (options.fresh) return loadDispatchOrdersForResponse(options);', 'if (false) return loadDispatchOrdersForResponse(options);', server],
  ['omit-split-digest', 'public/dispatch.js', '        currentPlan.digest = result.planDigest || currentPlan.digest;', '        // digest acknowledgement omitted', browser, 'further split'],
  ['keep-snapshot-locked', 'public/dispatch.js', 'if (["stale", "failed"].includes(dispatchPlannerSnapshotState) || (discoverPlan && !currentPlan?.id)) {', 'if (false) {', browser, 'temporary snapshot failure'],
  ['overwrite-unsaved-draft', 'public/dispatch.js', 'if (localPlanDirty || pendingPlanSaveAttempt || pendingDispatchPlanAction) return;', 'if (false) return;', browser, 'never replaces an unsaved draft'],
  ['accept-lagging-catalog', 'public/dispatch.js', 'if (!verify.length) return candidates;', 'if (true) return candidates;', browser, 'lagging catalog'],
  ['previous-selection-actions', 'public/dispatch.js', 'if (actions) actions.innerHTML = renderSelectedOrderActions();',
    'if (false) actions.innerHTML = renderSelectedOrderActions();', browser, 'immediate order actions'],
  ['retained-retired-assignment', 'public/dispatch.js', 'if (dispatchOrderRefKey(evidenceRef) === key) assignedOrderEvidenceById.delete(evidenceRef);',
    'if (false) assignedOrderEvidenceById.delete(evidenceRef);', browser, 'locally ungrouped'],
  ['retained-retired-catalog', 'public/dispatch.js', 'orderCatalog = orderCatalog.filter(order => dispatchOrderRefKey(order.id) !== key);',
    '// retired compact catalog record retained', browser, 'locally ungrouped'],
  ['ignore-new-day-plan', 'public/dispatch.js', '|| (discoverPlan && !currentPlan?.id)', '|| false', browser, 'empty day'],
  ['normal-group-as-rental', 'src/sor-rental-policy.js', 'child.sorOrder === true && child.sourceYard === RENTAL_YARD.code',
    'child.sourceYard === RENTAL_YARD.code', 'test/dispatch/unit/dispatch-freshness-sor.test.js'],
  ['rental-group-discards-linked-pickups', 'src/sor-rental-policy.js', 'sourceYard:RENTAL_YARD.code,sourceAddress:RENTAL_YARD.address,pickupLocations\n',
    'sourceYard:RENTAL_YARD.code,sourceAddress:RENTAL_YARD.address,pickupLocations:[RENTAL_YARD.code]\n', 'test/dispatch/unit/dispatch-freshness-sor.test.js'],
  ['selection-repaint-cancels-drag', 'public/dispatch.js', '  clearTimeout(orderClickTimer);\n  orderClickTimer = null;\n  const driverLaneHandle',
    '  const driverLaneHandle', browser, 'drag source stays mounted']
];
const results = [];
try {
  for (const directory of ['src', 'public', 'test']) cpSync(directory, `${root}/${directory}`, { recursive: true });
  cpSync('package.json', `${root}/package.json`);
  symlinkSync('/app/node_modules', `${root}/node_modules`);
  for (const [name, file, before, after, suite, pattern] of mutants) {
    const path = `${root}/${file}`, original = readFileSync(path, 'utf8');
    assert.equal(original.split(before).length, 2, `unique mutation anchor: ${name}`);
    try {
      writeFileSync(path, original.replace(before, after));
      const env = { ...process.env }; delete env.NODE_V8_COVERAGE; delete env.DISPATCH_FRESHNESS_COVERAGE;
      const args = ['--test', ...(pattern ? [`--test-name-pattern=${pattern}`] : []), suite];
      const result = spawnSync('node', args, { cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
      writeFileSync(`test-artifacts/mutant-${name}.log`, result.stdout + result.stderr);
      const failures = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match => match[1]);
      assert.ok(result.status === 1 && failures.length, `mutant survived: ${name}`);
      results.push({ name, suite, failures, killed: true });
      console.log(JSON.stringify(results.at(-1)));
    } finally { writeFileSync(path, original); }
  }
  writeFileSync('test-artifacts/mutations.json', JSON.stringify(results, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
