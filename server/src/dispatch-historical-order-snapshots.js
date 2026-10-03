import { query } from "./db.js";
import { historicalDispatchPlanDate } from "./dispatch-history-mode.js";

function coManifestCard(co,lines) {
  const items = lines.map(line => ({itemId: line.item_id,lineId: line.line_id,sku: line.sku,itemName: line.item_name,
    itemType: line.item_type,unit: line.unit,quantity: Number(line.quantity || 0),pallets: Number(line.pallet_qty || 0),
    layers: Number(line.layer_qty || 0),sections: Number(line.section_qty || 0),pieces: Number(line.piece_qty || 0),
    itemWeight: Number(line.item_weight || 0)}));
  const sum = field => items.reduce((total,item) => total+item[field],0);
  return {id: co.co_ref,type: "CO",sourceTable: "local_co_orders",sourceOrderId: co.source_order_ref,
    sourceYard: co.from_location,pickupLocations: [co.from_location],destinationYard: co.to_location,address: co.to_location,
    pallets: sum("pallets"),layers: sum("layers"),salesQty: sum("quantity"),items,planOwned: true,
    customer: co.details?.customer || "Transit Depot",childOrders: co.details?.childOrderIds || [],
    childOrderDetails: co.details?.childOrderDetails || []};
}

async function precedingCoManifestEvidence(plan,asOf,missing) {
  const cos = (await query(`SELECT * FROM local_co_orders
    WHERE (lower(co_ref)=ANY($1::text[]) OR lower(source_order_ref)=ANY($1::text[]))
    AND dispatch_plan_id=$2 AND dispatch_plan_date=$3::date AND updated_at <= $4 AND created_at <= $4`,
  [missing,plan.id,plan.planDate,asOf])).rows;
  const evidence = [];
  for (const co of cos) {
    const lines = (await query("SELECT * FROM local_co_order_lines WHERE co_id=$1 ORDER BY line_id,id",[co.id])).rows;
    if (!lines.length) { continue; }
    const manifest = coManifestCard(co,lines);
    if (missing.includes(co.co_ref.toLowerCase())) {
      evidence.push({stream: "local_co_manifest",source_id: String(co.id),evidence_at: co.updated_at,card: manifest});
    }
    const sourceCard = wholeGroupSourceManifest(co,manifest,plan);
    if (sourceCard && missing.includes(co.source_order_ref.toLowerCase())) {
      evidence.push({stream: "local_co_source_manifest",source_id: String(co.id),evidence_at: co.updated_at,card: sourceCard});
    }
  }
  return evidence;
}

function wholeGroupSourceManifest(co,manifest,plan) {
  const details = co.details || {};
  // Without child-specific manifests, CO creation carries the source order's
  // whole freight manifest. A filtered multi-yard child manifest cannot prove
  // the complete source cargo and must never be used for this recovery.
  if (!["SO","TO"].includes(details.sourceOrderType) || details.sourceOrderId !== co.source_order_ref
    || (details.childOrderIds || []).length < 2 || (details.childOrderDetails || []).length) { return null; }
  const drop = (plan.trucks || []).flatMap(truck => truck.loads || []).flatMap(load => load.stops || [])
    .find(stop => ["drop","dropoff","delivery"].includes(stop.type) && stop.orderId === co.source_order_ref);
  return {...manifest,id: co.source_order_ref,type: details.sourceOrderType,sourceTable: "historical_co_source_manifest",
    sourceYard: co.to_location,pickupLocations: [co.to_location],destinationYard: "",address: drop ? (drop.dropAddress || drop.address || "") : "",
    transitCo: {id: co.co_ref,fromYard: co.from_location,toYard: co.to_location,status: co.status,sourceOrderId: co.source_order_ref}};
}

function routedDropEvidence(plan) {
  return (plan.trucks || []).flatMap(truck => truck.loads || []).flatMap(load => (load.stops || [])
    .filter(stop => ["drop","dropoff","delivery"].includes(String(stop.type || "").toLowerCase()))
    .flatMap(stop => [stop.orderId,...(stop.orderRefs || [])].filter(Boolean)
      .map(ref => ({id: String(stop.id || ""),load_id: String(load.id || ""),order_ref: String(ref).toLowerCase()}))));
}

export async function hydrateHistoricalDispatchPlanOrders(plan) {
  if (!historicalDispatchPlanDate(plan.planDate)) { return {plan,reconstructed: []}; }
  const present = new Set();
  const visit = order => {
    present.add(String(order.id || "").toLowerCase());
    for (const child of order.childOrderDetails || []) { visit(child); }
  };
  for (const order of plan.orders || []) { visit(order); }
  const routed = routedDropEvidence(plan);
  const missing = [...new Set(routed.map(stop => stop.order_ref))].filter(ref => !present.has(ref));
  if (!missing.length) { return {plan,reconstructed: []}; }
  const asOf = new Date(plan.savedAt);
  if (!Number.isFinite(asOf.getTime())) { throw new Error("Historical order hydration requires the original save time"); }
  const evidence = (await query(`WITH retained AS (
      SELECT 'history' AS stream,id AS source_id,COALESCE(original_saved_at,archived_at) AS evidence_at,orders
        FROM dispatch_plan_snapshot_history WHERE plan_id=$1
          AND archive_reason IS DISTINCT FROM 'save_recovery'
          AND checkpoint_kind IS DISTINCT FROM 'recovery'
          AND summary->'saveRecovery'->'applied' IS DISTINCT FROM 'false'::jsonb
      UNION ALL
      SELECT 'command',id,created_at,
        COALESCE(result->'plan'->'orders',result->'plan'->'assignedOrderSnapshots','[]'::jsonb)
        FROM dispatch_plan_commands WHERE plan_id=$1 AND result->'plan' IS NOT NULL
      UNION ALL
      SELECT 'dispatch_drop_audit',audit.id,audit.created_at,jsonb_build_array(audit.details->'order')
        FROM dispatch_audit_log audit
       WHERE audit.action='order_dropped_to_load' AND audit.created_at <= $2
         AND lower(audit.details->'order'->>'id')=ANY($3::text[])
         AND (audit.plan_id IS NULL OR audit.plan_id=$1)
         AND EXISTS (
           SELECT 1 FROM jsonb_to_recordset($4::jsonb) route(id text,load_id text,order_ref text)
           CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(audit.after_state->'stops')='array'
             THEN audit.after_state->'stops' ELSE '[]'::jsonb END) stop
           WHERE route.id <> '' AND route.load_id <> '' AND audit.after_state->>'id'=route.load_id
             AND stop->>'id'=route.id AND lower(stop->>'orderId')=route.order_ref
             AND lower(audit.details->'order'->>'id')=route.order_ref
         )
    )
    SELECT DISTINCT ON (lower(card->>'id')) stream,source_id::text,evidence_at,card
      FROM retained CROSS JOIN LATERAL jsonb_array_elements(orders) card
     WHERE evidence_at <= $2 AND lower(card->>'id')=ANY($3::text[])
     ORDER BY lower(card->>'id'),evidence_at DESC,source_id DESC`,[plan.id,asOf,missing,JSON.stringify(routed)])).rows;
  const found = new Set(evidence.map(row => String(row.card.id).toLowerCase()));
  const unresolved = missing.filter(ref => !found.has(ref));
  if (unresolved.length) {
    evidence.push(...await precedingCoManifestEvidence(plan,asOf,unresolved));
  }
  const available = new Set(evidence.map(row => String(row.card.id).toLowerCase()));
  const unavailable = missing.filter(ref => !available.has(ref));
  if (unavailable.length) {
    throw Object.assign(new Error(`Historical routed order snapshots are missing: ${unavailable.join(", ")}.`),
      {code: "DISPATCH_HISTORY_ORDER_SNAPSHOT_MISSING",status: 409,orderRefs: unavailable});
  }
  return {plan: {...plan,orders: [...(plan.orders || []),...evidence.map(row => row.card)]},
    reconstructed: evidence.map(row => ({ref: row.card.id,stream: row.stream,sourceId: row.source_id,evidenceAt: row.evidence_at}))};
}
