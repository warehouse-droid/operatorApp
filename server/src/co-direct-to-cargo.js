import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { lockConsolidatedLoadOrders } from "./consolidation-load-locks.js";
import { dispatchLocationsShareYard } from "./dispatch-location.js";

const FIELDS = ["quantity", "pallet_qty", "layer_qty", "section_qty", "piece_qty"];
const ITEM_FIELDS = ["quantity", "pallets", "layers", "sections", "pieces"];
const PACKED = ["packed_sales_qty", "packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty"];

function conflict(message) {
  return Object.assign(new Error(message), { code: "CO_DIRECT_TO_CARGO_CONFLICT", status: 409 });
}

function quantity(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) {throw conflict("CO cargo has an invalid quantity.");}
  return number;
}

// Keep the independent CO requirement so refreshes and unlinking are reversible.
export function coDirectToRequirement(line, allocatedQuantity) {
  const base = Object.fromEntries(FIELDS.map(field => [field, quantity((line.raw?.coDirectToRequirement || line)[field])]));
  const allocated = quantity(allocatedQuantity);
  const remaining = Math.max(0, base.quantity - allocated);
  const ratio = base.quantity > 0 ? remaining / base.quantity : 1;
  return { base, required: Object.fromEntries(FIELDS.map(field => [field,
    Number((field === "quantity" ? remaining : base[field] * ratio).toFixed(6))])) };
}

export function restoreCoSourceRequirement(item) {
  const base = item.coDirectToRequirement;
  return base ? { ...item, ...Object.fromEntries(FIELDS.map((field, index) => [ITEM_FIELDS[index], quantity(base[field])])) } : item;
}

function sourceRefs(co) {
  return [...new Set([co.source_order_ref, ...(co.details?.childOrderIds || [])].filter(Boolean))];
}

function sourceLineFor(line, sources) {
  const rowId = line.raw?.lineRowId || line.raw?.line_row_id;
  const matches = sources.filter(source => String(source.item_id) === String(line.item_id)
    && (rowId ? String(source.id) === String(rowId) : String(source.line_id) === String(line.line_id)));
  if (matches.length > 1) {throw conflict("CO cargo matches multiple SO lines. Refresh its source line identity before linking.");}
  return matches[0];
}

function assertCargoEditable(co, line) {
  if (co.preparing_operator_id || co.preparing_started_at || co.status === "preparing"
    || line.confirmed_at || PACKED.some(field => quantity(line[field]) > 0)) {
    throw conflict(`${co.co_ref} has operator work on affected cargo. Release that work before changing its TO link.`);
  }
}

async function reconcileCo(co, requestedBy) {
  const lines = (await query("SELECT * FROM local_co_order_lines WHERE co_id=$1 ORDER BY id FOR UPDATE", [co.id])).rows;
  const sources = (await query(`SELECT line.*,sales.outbound_location FROM sales_order_lines line
    JOIN sales_orders sales ON sales.netsuite_id=line.sales_order_id
    WHERE sales.tranid=ANY($1::text[])`, [sourceRefs(co)])).rows
    .filter(line => dispatchLocationsShareYard(line.outbound_location, co.from_location));
  const allocations = (await query(`SELECT line.sales_line_id,SUM(line.allocated_quantity) AS quantity
    FROM order_dependency_lines line JOIN order_dependencies dep ON dep.id=line.dependency_id
    WHERE line.sales_line_id=ANY($1::bigint[]) AND line.line_role='sales_allocation'
      AND dep.dependency_mode='direct_to_customer' AND dep.status<>'cancelled'
      AND COALESCE(dep.dispatch_target_ref,dep.sales_order_ref)=ANY($2::text[])
    GROUP BY line.sales_line_id`, [sources.map(line => line.id), sourceRefs(co)])).rows;
  const byId = new Map(allocations.map(row => [String(row.sales_line_id), quantity(row.quantity)]));
  const changes = [];
  for (const line of lines) {
    const sourceId = sourceLineFor(line, sources)?.id;
    const allocated = byId.get(String(sourceId)) || 0;
    if (!allocated && !line.raw?.coDirectToRequirement) {continue;}
    const { base, required } = coDirectToRequirement(line, allocated);
    const changed = FIELDS.some(field => quantity(line[field]) !== required[field]);
    if (changed) {assertCargoEditable(co, line);}
    if (!changed && line.raw?.coDirectToRequirement) {continue;}
    await query(`UPDATE local_co_order_lines SET quantity=$2,pallet_qty=$3,layer_qty=$4,section_qty=$5,piece_qty=$6,
      raw=COALESCE(raw,'{}'::jsonb)||jsonb_build_object('coDirectToRequirement',$7::jsonb) WHERE id=$1`,
    [line.id, ...FIELDS.map(field => required[field]), JSON.stringify(base)]);
    changes.push({ lineId: line.id, salesLineId: sourceId, allocatedQuantity: allocated,
      before: Object.fromEntries(FIELDS.map(field => [field, line[field]])), after: required });
  }
  if (changes.length) {
    await writeAudit({ actorType: "dispatcher", source: "dispatch", action: "delivery.co.direct_to.reconciled",
      orderId: co.delivery_order_id, details: { coRef: co.co_ref, requestedBy, lines: changes } });
  }
  return { coRef: co.co_ref, changes };
}

export function reconcileCoDirectToCargo({ salesRefs = [], coRefs = [], requestedBy = "" } = {}) {
  return withTransaction(async () => {
    const candidates = (await query(`SELECT * FROM local_co_orders co
      WHERE (co.co_ref=ANY($1::text[]) OR co.source_order_ref=ANY($2::text[]) OR co.details->'childOrderIds' ?| $2::text[])
        AND co.status IN ('pending_load','preparing','packed','planned')
        AND co.loaded_at IS NULL AND co.received_at IS NULL ORDER BY co.id`, [coRefs, salesRefs])).rows;
    const sales = (await query("SELECT netsuite_id FROM sales_orders WHERE tranid=ANY($1::text[])",
      [[...new Set(candidates.flatMap(sourceRefs))]])).rows;
    await lockConsolidatedLoadOrders([...candidates.map(co => co.delivery_order_id || -Number(co.id)), ...sales.map(row => row.netsuite_id)]);
    const locked = (await query(`SELECT * FROM local_co_orders WHERE id=ANY($1::bigint[])
      AND status IN ('pending_load','preparing','packed','planned') AND loaded_at IS NULL AND received_at IS NULL
      ORDER BY id FOR UPDATE`, [candidates.map(co => co.id)])).rows;
    const results = [];
    for (const co of locked) {results.push(await reconcileCo(co, requestedBy));}
    return results;
  });
}
