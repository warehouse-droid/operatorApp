export const mutants = {
  noRelease: { file: "src/co-source-packing-handoff.js", from: 'await releaseSourcePacking(orders, lines, co.co_ref, options.requestedBy || "");', to: "await Promise.resolve();" },
  noOperatorMutex: { file: "src/co-source-packing-handoff.js", from: "await lockConsolidatedLoadOrders([...ids, ...(existing?.delivery_order_id ? [existing.delivery_order_id] : [])]);", to: "await Promise.resolve();" },
  noHeaderLock: { file: "src/co-source-packing-handoff.js", from: "ORDER BY netsuite_id FOR UPDATE", to: "ORDER BY netsuite_id" },
  noLineLock: { file: "src/co-source-packing-handoff.js", from: "ORDER BY id FOR UPDATE", to: "ORDER BY id" },
  keepConfirmation: { file: "src/co-source-packing-handoff.js", from: "confirmed=false,confirmed_at=null", to: "confirmed=confirmed,confirmed_at=confirmed_at" },
  clearUntouchedLines: { file: "src/co-source-packing-handoff.js", from: "WHERE id=ANY($1::bigint[])`, [packed.map(line => line.id)]);", to: "WHERE sales_order_id=$1`, [order.netsuite_id]);" },
  allowSourcePacking: { file: "src/delivery-repository.js", from: "await assertNoCoSourcePacking(await readOrder());", to: "await Promise.resolve();" },
  wrongSourceYard: { file: "src/co-source-packing-handoff.js", count: 2, from: ".filter(row => dispatchLocationsShareYard(row.outbound_location, options.fromYard))", to: ".filter(() => true)" },
  ignoreExecution: { file: "src/co-source-packing-handoff.js", from: "if (orders.length) {await assertUnexecutedSources(orders, lines, options.coRef);}", to: "if (false) {await assertUnexecutedSources(orders, lines, options.coRef);}" },
  ignoreCoLinkPacking: { file: "src/scm-dependency-preview-service.js", test: "test/dispatch/integration/scm-to-untouched-lines.test.js", from: "refs.push(...await coSourcePackingActivityRefs(salesRefs, salesLineIds));", to: "refs.push(...[]);" },
  omitCoLinkMutex: { file: "src/scm-dependency-preview-service.js", test: "test/dispatch/integration/scm-to-untouched-lines.test.js", from: "...sourceCos.map((row) => row.delivery_order_id).filter(Boolean)", to: "...[]" },
  ignoreConcurrentCoCreation: { file: "src/scm-dependency-preview-service.js", test: "test/dispatch/integration/scm-to-untouched-lines.test.js", from: "const currentCos = await coSourcePackingOrders(salesRefs);", to: "const currentCos = sourceCos;" },
  skipReactivatedCo: { file: "src/dispatch-repository.js", from: "reactivateCancelled: options.reactivateCancelled === true,", to: "reactivateCancelled: false," }
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const name = process.env.CO_HANDOFF_MUTANT;
  const mutant = mutants[name];
  if (!mutant || !url.endsWith(`/${mutant.file}`)) {return result;}
  const source = String(result.source);
  if (source.split(mutant.from).length !== (mutant.count || 1) + 1) {throw new Error(`Invalid handoff mutation anchor: ${name}`);}
  return { ...result, source: source.replaceAll(mutant.from, mutant.to) };
}
