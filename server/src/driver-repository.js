import { query } from "./db.js";

const YARD_ADDRESSES = {
  "3445": "3445 Kennedy Road, Toronto, ON",
  "2967": "2967 Kennedy Road, Toronto, ON",
  "12441": "12441 Woodbine Avenue, Whitchurch-Stouffville, ON"
};

function driverKey(value) {
  return String(value || "").trim().toLowerCase();
}

function planDateValue(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
}

function requiredPickupLocations(order) {
  if (Array.isArray(order?.pickupLocations) && order.pickupLocations.length) return order.pickupLocations.map(String);
  if (order?.sourceYard) return [String(order.sourceYard)];
  return ["3445"];
}

function jobId(plan, truck, load, stop) {
  return [plan.id, truck.id || truck.plate, load.id, stop.id].map((part) => encodeURIComponent(String(part || ""))).join(":");
}

function travelJobId(plan, truck, load, from, to) {
  return [plan.id, truck.id || truck.plate, load.id, "TRAVEL", from, to].map((part) => encodeURIComponent(String(part || ""))).join(":");
}

function sortedPlans(rows) {
  return rows.map((row) => ({
    id: row.id,
    planDate: planDateValue(row.plan_date),
    status: row.status,
    orders: Array.isArray(row.orders) ? row.orders : [],
    trucks: Array.isArray(row.trucks) ? row.trucks : []
  }));
}

function orderByRef(plan, ref) {
  return (plan.orders || []).find((order) => String(order.id) === String(ref)) || null;
}

function yardAddress(value) {
  return YARD_ADDRESSES[String(value || "")] || value || "";
}

async function locationAddress(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (YARD_ADDRESSES[text]) return YARD_ADDRESSES[text];
  const result = await query(
    `SELECT address
       FROM dispatch_vendor_yards
      WHERE LOWER(yard) = LOWER($1)
        AND COALESCE(address, '') <> ''
      ORDER BY active DESC, id
      LIMIT 1`,
    [text]
  );
  return result.rows[0]?.address || text;
}

function dropStopsForPickup(plan, load, location) {
  return (load.stops || []).filter((stop) => {
    if (stop.type !== "drop" || !stop.orderId) return false;
    const order = orderByRef(plan, stop.orderId);
    return requiredPickupLocations(order).map(String).includes(String(location));
  });
}

function firstPickupStop(load) {
  return (load.stops || []).find((stop) => stop.type === "pick") || null;
}

function buildTravelJob(plan, truck, load, truckIndex, loadIndex) {
  const firstPickup = firstPickupStop(load);
  if (!truck?.base || !firstPickup?.location || String(truck.base) === String(firstPickup.location)) return null;
  return {
    jobId: travelJobId(plan, truck, load, truck.base, firstPickup.location),
    planId: plan.id,
    planDate: plan.planDate,
    driverLogin: driverKey(truck.driverLogin || truck.driver),
    driverName: truck.driver || "",
    truckId: truck.id || "",
    truckPlate: truck.plate || "",
    parkingSpot: truck.parkingSpot || "",
    loadId: load.id || "",
    loadName: load.name || "",
    stopId: `travel-${truck.base}-${firstPickup.location}`,
    stopType: "travel",
    location: `${truck.base} to ${firstPickup.location}`,
    address: yardAddress(firstPickup.location),
    fromLocation: truck.base,
    fromAddress: yardAddress(truck.base),
    toLocation: firstPickup.location,
    toAddress: yardAddress(firstPickup.location),
    windowStart: "",
    windowEnd: "",
    instructions: "Travel to the pickup yard before loading.",
    orderRefs: [],
    orderTypes: [],
    requiredPhotos: 0,
    sequence: { truckIndex, loadIndex, stopIndex: -1 }
  };
}

function buildJob(plan, truck, load, stop, truckIndex, loadIndex, stopIndex) {
  const isPickup = stop.type === "pick";
  const relatedStops = isPickup ? dropStopsForPickup(plan, load, stop.location) : [stop];
  const orderRefs = [...new Set(relatedStops.map((item) => String(item.orderId || "")).filter(Boolean))];
  const firstOrder = orderByRef(plan, orderRefs[0]) || {};
  return {
    jobId: jobId(plan, truck, load, stop),
    planId: plan.id,
    planDate: plan.planDate,
    driverLogin: driverKey(truck.driverLogin || truck.driver),
    driverName: truck.driver || "",
    truckId: truck.id || "",
    truckPlate: truck.plate || "",
    parkingSpot: truck.parkingSpot || "",
    loadId: load.id || "",
    loadName: load.name || "",
    stopId: stop.id || "",
    stopType: isPickup ? "pickup" : "dropoff",
    location: isPickup ? stop.location : (firstOrder.destinationYard || firstOrder.address || ""),
    address: isPickup
      ? (firstOrder.sourceAddress || yardAddress(stop.location) || "")
      : (firstOrder.address || firstOrder.dropAddress || firstOrder.destinationYard || ""),
    windowStart: isPickup ? "" : (firstOrder.windowStart || ""),
    windowEnd: isPickup ? "" : (firstOrder.windowEnd || ""),
    instructions: firstOrder.notes || firstOrder.dispatchInstructions || "",
    orderRefs,
    orderTypes: [...new Set(orderRefs.map((ref) => orderByRef(plan, ref)?.type).filter(Boolean))],
    requiredPhotos: isPickup ? 2 : 1,
    sequence: { truckIndex, loadIndex, stopIndex }
  };
}

async function completedJobIds(jobIds) {
  if (!jobIds.length) return new Set();
  const result = await query(
    `SELECT job_id
       FROM driver_job_records
      WHERE job_id = ANY($1::text[])
        AND status = 'complete'`,
    [jobIds]
  );
  return new Set(result.rows.map((row) => row.job_id));
}

async function jobStatusMap(jobIds) {
  if (!jobIds.length) return new Map();
  const result = await query(
    `SELECT DISTINCT ON (job_id)
            job_id, status, started_at, completed_at
       FROM driver_job_records
      WHERE job_id = ANY($1::text[])
      ORDER BY job_id, completed_at DESC NULLS LAST, started_at DESC NULLS LAST, created_at DESC`,
    [jobIds]
  );
  return new Map(result.rows.map((row) => [row.job_id, row]));
}

async function confirmedPlans() {
  const result = await query(
    `SELECT p.id, p.plan_date, p.status, s.orders, s.trucks
       FROM dispatch_plans p
       INNER JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.status = 'confirmed'
      ORDER BY p.plan_date ASC, p.updated_at ASC`
  );
  return sortedPlans(result.rows);
}

async function detailsFromDelivery(orderRef, typeHint = "") {
  const typeClause = typeHint === "TO" ? "AND o.order_type = 'transfer_order'" : typeHint === "SO" ? "AND o.order_type = 'sales_order'" : "";
  const order = await query(
    `SELECT o.netsuite_id, o.tranid, o.order_type, o.customer AS party,
            o.dispatch_address, o.dispatch_window_start, o.dispatch_window_end, o.destination_location
       FROM delivery_orders o
      WHERE o.tranid = $1 ${typeClause}
      ORDER BY o.synced_at DESC
      LIMIT 1`,
    [orderRef]
  );
  if (!order.rowCount) return null;
  const lines = await query(
    `SELECT item_name, sku, item_description, item_type, quantity, unit,
            pallet_qty, layer_qty, section_qty, piece_qty
       FROM delivery_order_lines
      WHERE order_id = $1
        AND netsuite_active = true
      ORDER BY line_id NULLS LAST, id`,
    [order.rows[0].netsuite_id]
  );
  return { ...order.rows[0], source: "delivery", lines: lines.rows };
}

async function detailsFromReceiving(orderRef, typeHint = "") {
  const typeClause = typeHint === "TO" ? "AND o.order_type = 'transfer_order'" : typeHint === "PO" ? "AND o.order_type = 'purchase_order'" : "";
  const order = await query(
    `SELECT o.netsuite_id, o.tranid, o.order_type, o.vendor AS party,
            o.dispatch_address, o.dispatch_window_start, o.dispatch_window_end, o.destination_location
       FROM receiving_orders o
      WHERE o.tranid = $1 ${typeClause}
      ORDER BY o.synced_at DESC
      LIMIT 1`,
    [orderRef]
  );
  if (!order.rowCount) return null;
  const lines = await query(
    `SELECT item_name, sku, item_description, item_type, quantity, unit,
            pallet_qty, layer_qty, section_qty, piece_qty
       FROM receiving_order_lines
      WHERE order_id = $1
        AND netsuite_active = true
      ORDER BY line_id NULLS LAST, id`,
    [order.rows[0].netsuite_id]
  );
  return { ...order.rows[0], source: "receiving", lines: lines.rows };
}

async function detailsFromLocalCo(orderRef) {
  const order = await query(
    `SELECT id, co_ref AS tranid, 'co_order' AS order_type,
            COALESCE(details->>'customer', 'Transit Depot') AS party,
            details->>'notes' AS dispatch_instructions,
            to_location AS destination_location
       FROM local_co_orders
      WHERE co_ref = $1
      LIMIT 1`,
    [orderRef]
  );
  if (!order.rowCount) return null;
  const lines = await query(
    `SELECT item_name, sku, item_description, item_type, quantity, unit,
            pallet_qty, layer_qty, section_qty, piece_qty
       FROM local_co_order_lines
      WHERE co_id = $1
      ORDER BY line_id NULLS LAST, id`,
    [order.rows[0].id]
  );
  return { ...order.rows[0], source: "local_co", lines: lines.rows };
}

function visibleUnits(line) {
  const values = [
    ["PLT", line.pallet_qty],
    ["LYR", line.layer_qty],
    ["SEC", line.section_qty],
    ["PCS", line.piece_qty]
  ].filter(([, value]) => Number(value || 0) > 0);
  if (values.length) return values.map(([unit, value]) => ({ unit, value: Number(value) }));
  return [{ unit: line.unit || "UOM", value: Number(line.quantity || 0), fallback: true }];
}

function isMaterialLine(line) {
  const itemType = String(line.item_type || "").trim();
  if (!itemType) return true;
  return ["InvtPart", "NonInvtPart"].includes(itemType);
}

async function orderDetails(orderRef, typeHint = "") {
  const detail = typeHint === "PO"
    ? await detailsFromReceiving(orderRef, "PO")
    : typeHint === "CO"
      ? await detailsFromLocalCo(orderRef)
      : typeHint === "TO"
        ? await detailsFromDelivery(orderRef, "TO") || await detailsFromReceiving(orderRef, "TO")
        : await detailsFromDelivery(orderRef, "SO") || await detailsFromReceiving(orderRef) || await detailsFromLocalCo(orderRef);
  if (!detail) return {
    orderRef,
    party: "",
    items: []
  };
  return {
    orderRef,
    party: detail.party || "",
    source: detail.source,
    items: (detail.lines || []).filter(isMaterialLine).map((line) => ({
      itemName: line.item_name || line.sku || "",
      sku: line.sku || line.item_name || "",
      description: line.item_description || "",
      units: visibleUnits(line)
    }))
  };
}

export async function getNextDriverJob(driverLogin) {
  const login = driverKey(driverLogin);
  const plans = await confirmedPlans();
  const jobs = [];
  for (const plan of plans) {
    (plan.trucks || []).forEach((truck, truckIndex) => {
      if (driverKey(truck.driverLogin || truck.driver) !== login) return;
      (truck.loads || []).forEach((load, loadIndex) => {
        if (load.returnOnly) return;
        const travelJob = buildTravelJob(plan, truck, load, truckIndex, loadIndex);
        if (travelJob) jobs.push(travelJob);
        (load.stops || []).forEach((stop, stopIndex) => {
          if (!["pick", "drop"].includes(stop.type)) return;
          jobs.push(buildJob(plan, truck, load, stop, truckIndex, loadIndex, stopIndex));
        });
      });
    });
  }
  const jobIds = jobs.map((job) => job.jobId);
  const completed = await completedJobIds(jobIds);
  const statuses = await jobStatusMap(jobIds);
  const next = jobs.find((job) => !completed.has(job.jobId));
  if (!next) return null;
  const status = statuses.get(next.jobId);
  next.status = status?.status || "pending";
  next.startedAt = status?.started_at || null;
  next.completedAt = status?.completed_at || null;
  if (next.stopType === "travel") {
    next.address = await locationAddress(next.toLocation || next.address);
    next.fromAddress = await locationAddress(next.fromLocation || next.fromAddress);
  } else if (next.stopType === "pickup") {
    next.address = await locationAddress(next.location || next.address);
  }
  const details = await Promise.all(next.orderRefs.map((ref) => {
    const hint = next.orderTypes.length === 1 ? next.orderTypes[0] : "";
    return orderDetails(ref, hint);
  }));
  return { ...next, orders: details };
}

export async function startDriverJob(driverLogin, jobIdValue, { job = null } = {}) {
  if (!job) throw new Error("Driver job is no longer available.");
  const result = await query(
    `INSERT INTO driver_job_records (
       job_id, plan_id, plan_date, driver_login, truck_id, truck_plate, load_id, load_name,
       stop_id, stop_type, order_refs, photo_data_urls, status, started_at, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11::jsonb, '[]'::jsonb, 'in_progress', now(), NULL
     )
     ON CONFLICT (job_id) DO UPDATE SET
       status = CASE WHEN driver_job_records.status = 'complete' THEN driver_job_records.status ELSE 'in_progress' END,
       started_at = COALESCE(driver_job_records.started_at, now()),
       plan_id = EXCLUDED.plan_id,
       plan_date = EXCLUDED.plan_date,
       driver_login = EXCLUDED.driver_login,
       truck_id = EXCLUDED.truck_id,
       truck_plate = EXCLUDED.truck_plate,
       load_id = EXCLUDED.load_id,
       load_name = EXCLUDED.load_name,
       stop_id = EXCLUDED.stop_id,
       stop_type = EXCLUDED.stop_type,
       order_refs = EXCLUDED.order_refs
     RETURNING *`,
    [
      jobIdValue,
      job?.planId || null,
      job?.planDate || null,
      driverKey(driverLogin),
      job?.truckId || "",
      job?.truckPlate || "",
      job?.loadId || "",
      job?.loadName || "",
      job?.stopId || "",
      job?.stopType || "",
      JSON.stringify(job?.orderRefs || [])
    ]
  );
  return result.rows[0];
}

export async function recordDriverJobPhotos(driverLogin, jobIdValue, { photoDataUrls = [], job = null } = {}) {
  const photos = Array.isArray(photoDataUrls) ? photoDataUrls.filter(Boolean) : [];
  const requiredPhotos = job?.requiredPhotos ?? 1;
  if (photos.length < requiredPhotos) throw new Error(`${requiredPhotos} photo${requiredPhotos > 1 ? "s are" : " is"} required.`);
  const result = await query(
    `INSERT INTO driver_job_records (
       job_id, plan_id, plan_date, driver_login, truck_id, truck_plate, load_id, load_name,
       stop_id, stop_type, order_refs, photo_data_urls, status, started_at, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11::jsonb, $12::jsonb, 'complete', COALESCE($13::timestamptz, now()), now()
     )
     ON CONFLICT (job_id) DO UPDATE SET
       photo_data_urls = EXCLUDED.photo_data_urls,
       status = 'complete',
       started_at = COALESCE(driver_job_records.started_at, EXCLUDED.started_at, now()),
       completed_at = now()
     RETURNING *`,
    [
      jobIdValue,
      job?.planId || null,
      job?.planDate || null,
      driverKey(driverLogin),
      job?.truckId || "",
      job?.truckPlate || "",
      job?.loadId || "",
      job?.loadName || "",
      job?.stopId || "",
      job?.stopType || "",
      JSON.stringify(job?.orderRefs || []),
      JSON.stringify(photos),
      job?.startedAt || null
    ]
  );
  return result.rows[0];
}

export async function listDriverJobStatuses({ planId = null, planDate = null } = {}) {
  const params = [];
  const clauses = [];
  if (planId) {
    params.push(planId);
    clauses.push(`plan_id = $${params.length}`);
  }
  if (planDate) {
    params.push(planDate);
    clauses.push(`plan_date = $${params.length}::date`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `SELECT job_id, plan_id, plan_date, driver_login, truck_id, truck_plate, load_id, load_name,
            stop_id, stop_type, order_refs, status, started_at, completed_at
       FROM driver_job_records
      ${where}
      ORDER BY plan_date DESC NULLS LAST, started_at DESC NULLS LAST, completed_at DESC NULLS LAST, id DESC
      LIMIT 1000`,
    params
  );
  return result.rows;
}
