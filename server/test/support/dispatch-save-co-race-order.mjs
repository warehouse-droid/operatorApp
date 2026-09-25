// Diagnostic scheduling only: reverse the two concurrently submitted operations.
// The existing test's assertions and both production implementations are intact.
import assert from 'node:assert/strict';
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js')) return result;
  let source = String(result.source);
  const start = source.indexOf('const [saveResult, cancelResult] = await Promise.allSettled([');
  assert.ok(start > 0);
  const end = source.indexOf('\n  ]);', start);
  const argsStart = source.indexOf('([', start) + 2;
  const split = source.indexOf('\n    cancelLocalCoOrder(coRef,', argsStart);
  assert.ok(end > split && split > argsStart);
  const save = source.slice(argsStart, split).trim().replace(/,$/, '');
  const cancel = source.slice(split, end).trim();
  source = source.slice(0, start) + 'const [cancelResult, saveResult] = await Promise.allSettled([\n    '
    + cancel + ',\n    ' + save + source.slice(end);
  const anchor = '  assert.equal([saveResult, cancelResult].filter';
  assert.ok(source.includes(anchor));
  source = source.replace(anchor, `  const observedCo = await coJson(coRef);
  const observedSnapshot = (await query('SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id=$1', [plan.id])).rows[0];
  const observedPlanned = JSON.stringify(observedSnapshot?.trucks || []).includes(coRef);
  assert.equal(observedPlanned && observedCo?.status === 'cancelled', false, 'the data integrity invariant still holds');
  console.log(JSON.stringify({ diagnostic: 'cancel-first', planned: observedPlanned, coStatus: observedCo?.status,
    save: saveResult.status, cancel: cancelResult.status, integrityPreserved: true }));
` + anchor);
  return { ...result, source };
}
