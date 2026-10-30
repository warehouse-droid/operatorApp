const target = '/src/operator-order-progress-repository.js';
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith(target)) { return result; }
  const source = String(result.source);
  const changes = {
    'accounting-load': ['operatorCargoLine(line) && Number(line.loaded_qty || 0) > 0', 'Number(line.loaded_qty || 0) > 0'],
    'accounting-pack': ['return operatorCargoLine(line) && (', 'return ('],
    'lost-cargo-load': ['operatorCargoLine(line) && Number(line.loaded_qty || 0) > 0', 'operatorCargoLine(line) && Number(line.loaded_qty || 0) > 1000'],
    'lost-cargo-pack': ['return operatorCargoLine(line) && (', 'return false && ('],
    'lost-header-load': ['[header.operator_status, header.outbound_operator_status, header.local_yard_order_status]', '[]'],
    'named-service': ["return !accountingType && !/^(delivery charge|sales credit)/iu.test(text(line.sku || line.item_name));", 'return !accountingType;']
  };
  const [before, after] = changes[process.env.CARGO_MUTANT] || [];
  if (!before || !source.includes(before)) { throw new Error('Mutation target missing: ' + process.env.CARGO_MUTANT); }
  return { ...result, source: source.replace(before, after) };
}
