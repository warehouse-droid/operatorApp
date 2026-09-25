import assert from 'node:assert/strict';

export const mutants = {
  retain_stale_weight: ['src/purchase-order-weight-refresh.js', 'SET item_weight = changed.item_weight', 'SET item_weight = line.item_weight'],
  wrong_item: ['src/purchase-order-weight-refresh.js', 'AND weight.item_id = line.item_id', ''],
  omit_splits: ['src/purchase-order-weight-refresh.js', "split.status = 'active'", "split.status = 'cancelled'"],
  scale_weight: ['src/purchase-order-weight-refresh.js', 'const weight = Number(value);', 'const weight = Number(value) * 10;'],
  stale_identity_after_lock: ['src/purchase-order-weight-refresh.js', 'AND line.item_id = target.item_id AND COALESCE(line.netsuite_active, true)', ''],
  read_po_weights_for_so: ['src/netsuite-delayed-status-refresh-service.js',
    'if (job.orderType === "purchase_order") {\n      lines =',
    'if (job.orderType !== "transfer_order") {\n      lines =']
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutation = mutants[process.env.PO_ITEM_WEIGHT_MUTANT];
  if (!mutation || !url.endsWith(`/${mutation[0]}`)) {
    return result;
  }
  const source = String(result.source);
  assert.equal(source.split(mutation[1]).length, 2, 'Mutant must match exactly once');
  return { ...result, source: source.replace(mutation[1], mutation[2]) };
}
