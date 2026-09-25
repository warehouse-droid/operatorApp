import { pool, query, withTransaction, closeDb } from '../src/db.js';
import { getSmartScmProposalInventorySnapshot } from '../src/smart-scm-proposal-editor.js';
import { loadSmartScmPlanningDemandStates } from '../src/smart-scm-planning-repository.js';

pool.options.options = '-c jit=off -c default_transaction_read_only=on -c statement_timeout=60000';
const n = value => Number(value || 0);
const positive = value => Math.max(0, n(value));
const round = value => Math.round((value + Number.EPSILON) * 1e6) / 1e6;
const key = (item, location) => `${item}:${location}`;
const add = (map, k, value) => map.set(k, n(map.get(k)) + n(value));
const rows = async sql => (await query(sql)).rows;
const differs = (a, b) => Math.abs(n(a) - n(b)) > 0.000001;
const normalizeRef = value => String(value || '').trim().toLowerCase();

try {
  const started = performance.now();
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const balances = await rows(`SELECT b.*,i.item_name,i.to_plt FROM inventory_balances b
      JOIN inventory_items i ON i.item_id=b.item_id WHERE b.location_id IN (1,28,15,26) ORDER BY b.item_id,b.location_id`);
    const items = await rows('SELECT item_id,item_name,to_plt FROM inventory_items ORDER BY item_id');
    const splits = await rows(`SELECT split.id AS split_id,split.split_po_ref,split.source_po_ref,
      split.source_po_id,split.split_po_id,split.status AS split_status,ledger.id AS ledger_id,
      ledger.item_id,child.item_name,child.id AS child_line_id,child.quantity,child.netsuite_received_qty,
      child.netsuite_received_baseline_qty,child.received_sales_qty,child.received_pallet_qty,
      child.received_layer_qty,child.received_section_qty,child.received_piece_qty,
      child.to_plt,child.to_lyr,child.to_sec,child.to_pcs,child.confirmed_at,
      child.netsuite_active AS line_active,child.netsuite_closed,
      po.receipt_status,po.received_at,po.status_text,po.netsuite_active AS po_active,
      source_po.is_blanket_po,source_po.status_text AS source_status,source_po.netsuite_active AS source_active,
      source_line.quantity AS source_quantity,source_line.netsuite_received_qty AS source_received,
      source_line.netsuite_closed AS source_closed,
      COALESCE(child.location_id,po.destination_location_id) AS destination,
      COALESCE(source_line.location_id,source_po.destination_location_id) AS source
      FROM dispatch_scm_po_split_lines ledger
      JOIN dispatch_scm_po_splits split ON split.id=ledger.split_id
      JOIN purchase_order_lines child ON child.id=ledger.split_line_id
      JOIN purchase_orders po ON po.netsuite_id=split.split_po_id
      JOIN purchase_order_lines source_line ON source_line.id=ledger.source_line_id
      JOIN purchase_orders source_po ON source_po.netsuite_id=split.source_po_id`);
    const allocations = await rows(`SELECT a.po_split_line_id,a.quantity,a.progress_kind,a.active,a.allocation_method
      FROM scm_reconciliation_allocations a WHERE a.target_kind='po_split'`);
    const completions = new Set((await rows(`SELECT order_ref FROM dispatch_order_completion_status
      WHERE order_kind='PO' AND dispatch_completion_status='completed'`)).map(row => normalizeRef(row.order_ref)));
    const blanketLines = await rows(`SELECT l.item_id,COALESCE(l.location_id,p.destination_location_id) AS location,
      l.quantity,l.netsuite_received_qty FROM purchase_order_lines l JOIN purchase_orders p ON p.netsuite_id=l.purchase_order_id
      WHERE l.netsuite_active AND p.netsuite_active AND p.is_blanket_po AND NOT COALESCE(l.netsuite_closed,false)
      AND (p.status_text ILIKE '%Pending Receipt%' OR p.status_text ILIKE '%Partially Received%')
      AND NOT EXISTS(SELECT 1 FROM dispatch_scm_po_splits s WHERE s.split_po_id=p.netsuite_id)`);
    const blanketReservations = await rows(`SELECT item_id,destination_location_id,status,reserved_sales_qty,held_sales_qty
      FROM scm_smart_blanket_allocations WHERE status IN ('reserved','held')`);
    const transferReservations = await rows(`SELECT item_id,source_location_id,destination_location_id,reserved_sales_quantity
      FROM scm_smart_inventory_reservations WHERE status='active'`);
    const allocated = new Map(), blanket = new Map(), released = new Map(), relocation = new Map();
    const held = new Map(), incoming = new Map(), outgoing = new Map();
    for (const a of allocations) if (a.active && a.progress_kind === 'received') add(allocated, String(a.po_split_line_id), a.quantity);
    for (const line of blanketLines) add(blanket, key(line.item_id, line.location), positive(n(line.quantity) - n(line.netsuite_received_qty)));
    for (const a of blanketReservations) add(held, key(a.item_id, a.destination_location_id), a.status === 'held' ? a.held_sales_qty : a.reserved_sales_qty);
    for (const r of transferReservations) {
      add(incoming, key(r.item_id, r.destination_location_id), r.reserved_sales_quantity);
      add(outgoing, key(r.item_id, r.source_location_id), r.reserved_sales_quantity);
    }
    const splitEvidence = [];
    for (const s of splits) {
      if (s.split_status !== 'active' || !s.po_active || !s.line_active || s.netsuite_closed
          || /(closed|cancelled|fully received)/i.test(s.status_text || '')) continue;
      const terminal = normalizeRef(s.receipt_status) === 'received' || completions.has(normalizeRef(s.split_po_ref));
      const posted = s.confirmed_at && s.received_at && new Date(s.confirmed_at) <= new Date(s.received_at)
        && normalizeRef(s.receipt_status) === 'partial_received';
      const physical = [['received_pallet_qty','to_plt'],['received_layer_qty','to_lyr'],
        ['received_section_qty','to_sec'],['received_piece_qty','to_pcs']]
        .reduce((sum, [count, factor]) => sum + positive(s[count]) * positive(s[factor]), 0);
      const local = positive(s.netsuite_received_baseline_qty) + (posted ? Math.max(0, n(s.received_sales_qty), physical) : 0);
      const reconciled = n(allocated.get(String(s.ledger_id)));
      const previous = terminal ? 0 : positive(n(s.quantity) - Math.max(n(s.netsuite_received_qty), local));
      const remaining = terminal ? 0 : positive(n(s.quantity) - Math.max(n(s.netsuite_received_qty), local, reconciled));
      splitEvidence.push({ ...s, reconciled, previous: round(previous), remaining: round(remaining) });
      if (s.is_blanket_po) add(released, key(s.item_id, s.destination), remaining);
      else if (s.source !== s.destination) {
        add(relocation, key(s.item_id, s.source), -remaining);
        add(relocation, key(s.item_id, s.destination), remaining);
      }
    }
    const balanceMap = new Map(balances.map(row => [key(row.item_id, row.location_id), row]));
    const itemMap = new Map(items.map(row => [String(row.item_id), row]));
    const keys = new Set(balances.map(row => key(row.item_id, row.location_id)));
    for (const map of [released, relocation, held, incoming, outgoing, blanket]) for (const k of map.keys()) if (!k.endsWith(':null')) keys.add(k);
    const expected = (k, planner = false) => {
      const b = balanceMap.get(k) || {};
      const authoritative = positive(n(b.quantity_on_order) + (planner ? n(relocation.get(k)) : 0));
      return round(Math.max(0, authoritative - positive(blanket.get(k)))
        + positive(released.get(k)) + positive(held.get(k)) + positive(incoming.get(k)));
    };
    const inventory = [], snapshotMismatches = [];
    for (const k of keys) {
      const [itemId, locationId] = k.split(':').map(Number);
      const item = itemMap.get(String(itemId)) || {};
      const actual = await getSmartScmProposalInventorySnapshot(itemId, locationId, item.to_plt);
      const row = { key: k, itemName: item.item_name, toPlt: n(item.to_plt),
        balance: balanceMap.get(k) || null, actual, expectedOnOrder: expected(k) };
      inventory.push(row);
      if (differs(actual.quantityOnOrder, row.expectedOnOrder)) snapshotMismatches.push(row);
    }
    const planning = await loadSmartScmPlanningDemandStates({ includeTemporarilyExcluded: true });
    const planner = planning.states.map(s => ({ key: s.key, itemName: s.policy.item_name,
      actualOnOrder: s.onOrderSales, expectedOnOrder: expected(s.key, true), releasedSplit: s.releasedSplitInboundSales }));
    const saved = await rows(`SELECT p.id AS proposal_id,p.run_id,p.status,p.proposal_type,p.proposal_origin,
      p.netsuite_purchase_order_id,p.netsuite_transfer_order_id,l.id AS line_id,l.item_id,l.item_name,
      COALESCE(l.destination_location_id,p.destination_location_id) AS location_id,l.to_plt,l.proposed_pallets,l.reason,
      r.revision,r.status AS run_status,r.plan_kind,r.planning_phase
      FROM scm_smart_proposal_lines l JOIN scm_smart_proposals p ON p.id=l.proposal_id
      JOIN scm_smart_planning_runs r ON r.id=p.run_id
      WHERE p.superseded_at IS NULL AND p.status IN ('draft','held','proposed','approved','order_requested','vendor_replied')
      AND p.run_id IN (SELECT MAX(id) FROM scm_smart_planning_runs WHERE status='ready' GROUP BY plan_kind)
      ORDER BY p.run_id,p.id,l.id`);
    const savedMismatches = saved.filter(row => row.reason?.quantityOnOrder !== undefined
      && differs(row.reason.quantityOnOrder, expected(key(row.item_id, row.location_id))))
      .map(row => ({ ...row, expectedOnOrder: expected(key(row.item_id, row.location_id)) }));
    const sourceConflicts = splitEvidence.filter(row => row.remaining > 0 && (
      row.source_closed || !row.source_active || /(closed|cancelled)/i.test(row.source_status || '')
      || (n(row.source_quantity) > 0 && n(row.source_received) >= n(row.source_quantity))
    ));
    return { capturedAt: new Date().toISOString(), summary: {
      items: new Set(inventory.map(row => row.key.split(':')[0])).size, itemYards: inventory.length,
      activeSplits: splitEvidence.length, overstatedSplitLines: splitEvidence.filter(row => differs(row.previous, row.remaining)).length,
      snapshotMismatches: snapshotMismatches.length, plannerStates: planner.length,
      plannerMismatches: planner.filter(row => differs(row.actualOnOrder, row.expectedOnOrder)).length,
      editableProposalLines: saved.length, savedMismatches: savedMismatches.length,
      remainingSourceConflicts: sourceConflicts.length
    }, inventory, snapshotMismatches, plannerMismatches: planner.filter(row => differs(row.actualOnOrder, row.expectedOnOrder)),
    splitEvidence, sourceConflicts, savedMismatches, saved };
  }, { rollback: true });
  console.log(JSON.stringify({ ...result, elapsedMs: Math.round(performance.now() - started) }));
} finally { await closeDb(); }
