// Pure maintenance planning. Remote accounting never supplies a physical quantity.
const same = (a, b) => String(a) === String(b);
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const pickable = line => line.netsuite_active !== false && ['InvtPart', 'NonInvtPart'].includes(line.item_type) && positive(line.quantity) > 0;
const packed = line => ['packed_pallet_qty', 'packed_layer_qty', 'packed_section_qty', 'packed_piece_qty', 'packed_sales_qty'].some(key => positive(line[key]) > 0);

export function physicalLoadedQuantities(lines, loads) {
  const quantities = new Map(), units = new Map(), issues = [];
  for (const record of loads) {
    if (record.load_type !== 'transfer_order_load') {continue;}
    for (const saved of record.line_snapshot || []) {
      const quantity = positive(saved.loadedQty);
      if (!quantity) {continue;}
      const matches = lines.filter(line => line.line_stage === 'outbound' && same(line.line_id, saved.lineId) && same(line.item_id, saved.itemId));
      if (matches.length !== 1) { issues.push(`Load ${record.id}: saved item/line cannot be uniquely matched`); continue; }
      const key = String(matches[0].id);
      if (quantity > (quantities.get(key) || 0)) {
        quantities.set(key, quantity);
        units.set(key, saved.loadedUom || saved.unit || matches[0].unit);
      }
    }
  }
  return { quantities, units, issues };
}

function changedLoadQuantities(lines, loaded) {
  return lines.filter(line => line.line_stage === 'outbound').map(line => ({
    id: line.id, loaded_qty: loaded.quantities.get(String(line.id)) || 0,
    loaded_uom: loaded.quantities.has(String(line.id)) ? loaded.units.get(String(line.id)) : null
  })).filter(change => {
    const line = lines.find(row => same(row.id, change.id));
    return Math.abs(Number(line.loaded_qty || 0) - change.loaded_qty) > 0.000001 || (line.loaded_uom || null) !== change.loaded_uom;
  });
}

function recordPhysicalReceiptQuantities(received, lines, legacy) {
  for (const saved of lines) {
    if (saved.itemReceive === false) {continue;}
    const key = String(legacy ? saved.orderLine : saved.sourceLineKey), previous = received.get(key) || 0;
    const quantity = positive(legacy ? saved.quantity : saved.cumulativeQuantity);
    received.set(key, legacy ? previous + quantity : Math.max(previous, quantity));
  }
}

function physicalReceiptQuantities(receipts, jobs) {
  const received = new Map();
  const successful = receipts.filter(record => ['received', 'partial_received'].includes(record.receipt_status));
  for (const record of successful) {
    const job = jobs.find(row => row.transaction_type === 'IR' && same(row.operator_record_id, record.id));
    const lines = job ? job.snapshot.lines || [] : record.payload?.item?.items || [];
    recordPhysicalReceiptQuantities(received, lines, !job);
  }
  return received;
}

function physicalLineProgress(lines, quantities, key) {
  return { any: lines.some(line => (quantities.get(String(line[key])) || 0) > 0),
    complete: lines.length > 0 && lines.every(line => (quantities.get(String(line[key])) || 0) + 0.000001 >= positive(line.quantity)) };
}

function plannedOutboundStatus(order, outbound, progress) {
  if (progress.complete) {return 'loaded';}
  if (order.outbound_operator_status === 'preparing' && order.preparing_operator_id) {return 'preparing';}
  if (outbound.some(packed)) {return 'packed';}
  return progress.any ? 'partial_loaded' : 'open';
}

function plannedYardHeader(order, lines, loaded, received) {
  const outbound = lines.filter(line => line.line_stage === 'outbound' && pickable(line));
  const receiving = lines.filter(line => line.line_stage === 'receiving' && pickable(line));
  const loadProgress = physicalLineProgress(outbound, loaded.quantities, 'id');
  const receiptProgress = physicalLineProgress(receiving, received, 'line_id');
  return { outbound_operator_status: plannedOutboundStatus(order, outbound, loadProgress),
    local_yard_order_status: loadProgress.complete ? 'Loaded' : loadProgress.any ? 'Partial Loaded' : 'Open',
    receiving_status: receiptProgress.complete ? 'received' : receiptProgress.any ? 'partial_received' : 'not_received' };
}

export function planLocalYardState({ order, lines, loads, receipts, jobs, direct = false, historical = false, closed = false }) {
  if (direct || historical || closed) {return { kind: direct ? 'direct_to_customer' : historical ? 'historical_completed' : 'closed', changes: [], header: null, issues: [] };}
  const loaded = physicalLoadedQuantities(lines, loads);
  if (loaded.issues.length) {return { kind: 'review', changes: [], header: null, issues: loaded.issues };}
  const changes = changedLoadQuantities(lines, loaded), received = physicalReceiptQuantities(receipts, jobs);
  return { kind: 'operational', changes, issues: [], header: {
    ...plannedYardHeader(order, lines, loaded, received)
  } };
}

export function receivingRowsForMissingLines(lines, source) {
  const rows = [], issues = [];
  for (const local of lines.filter(line => line.line_stage === 'outbound' && pickable(line))) {
    const outbound = source.lines.filter(line => line.stage === 'outbound' && line.identityStatus === 'exact'
      && same(line.itemId, local.item_id) && [line.sourceLineKey, ...(line.sourceLineAliases || [])].some(key => same(key, local.line_id)));
    if (outbound.length !== 1) { issues.push(`Line ${local.line_id}: source identity is not unique`); continue; }
    const counterpart = source.lines.filter(line => line.stage === 'receiving' && line.identityStatus === 'exact'
      && line.logicalLineIdentity === outbound[0].logicalLineIdentity && same(line.itemId, local.item_id));
    if (counterpart.length !== 1) { issues.push(`Line ${local.line_id}: destination identity is not unique`); continue; }
    const target = counterpart[0];
    if (lines.some(line => line.line_stage === 'receiving' && [target.sourceLineKey, ...(target.sourceLineAliases || [])].some(key => same(key, line.line_id)))) {continue;}
    if (String(local.unit || '').toUpperCase() !== String(target.unit || '').toUpperCase()) {
      issues.push(`Line ${local.line_id}: source and local units differ`); continue;
    }
    rows.push({ line_id: target.sourceLineKey, netsuite_order_line: target.netsuite_order_line,
      item_id: local.item_id, item_name: local.item_name, item_type: local.item_type, item_description: local.item_description,
      quantity: positive(local.quantity), unit: local.unit, location_id: source.destinationLocationId, location: source.destinationLocation,
      pallet_qty: positive(local.pallet_qty), layer_qty: positive(local.layer_qty), section_qty: positive(local.section_qty), piece_qty: positive(local.piece_qty),
      to_plt: local.to_plt, to_lyr: local.to_lyr, to_sec: local.to_sec, to_pcs: local.to_pcs,
      netsuite_received_qty: positive(target.cumulativeProgressQuantity) });
  }
  return { rows, issues };
}

export function verifiedHistoricalCompletion(order, source, linked) {
  if (source?.status !== 'G' || order.outbound_operator_status !== 'loaded' || order.receiving_status !== 'received') {return false;}
  const lines = source.lines.filter(line => line.stage === 'outbound' && line.identityStatus === 'exact' && positive(line.quantity) > 0);
  return lines.length > 0 && lines.every(line => ['ItemShip', 'ItemRcpt'].every(type => {
    const related = line.logicalLineIdentity ? source.lines.filter(other => other.logicalLineIdentity === line.logicalLineIdentity && same(other.itemId, line.itemId)) : [line];
    const aliases = related.flatMap(other => [other.sourceLineKey, ...(other.sourceLineAliases || [])]);
    const events = linked.filter(event => event.transactionType === type && same(event.itemId, line.itemId)
      && aliases.some(key => (event.sourceLineAliases || [event.sourceLineKey]).some(alias => same(alias, key))));
    const unique = new Map(events.map(event => [`${event.transactionId}:${event.transactionLineKey}`, event]));
    return [...unique.values()].reduce((sum, event) => sum + positive(event.quantity), 0) + 0.000001 >= positive(line.quantity);
  }));
}
