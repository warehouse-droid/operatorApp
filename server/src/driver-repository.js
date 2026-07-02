import { query } from "./db.js";
import { config } from "./config.js";
import { createSamsaraDriverVehicleAssignment, createSamsaraMechanicDvir, findSamsaraDvirForVehicle, setSamsaraDriverDutyStatus } from "./samsara.js";

const YARD_ADDRESSES = {
  "3445": "3445 Kennedy Road, Toronto, ON",
  "2967": "2967 Kennedy Road, Toronto, ON",
  "12441": "12441 Woodbine Avenue, Whitchurch-Stouffville, ON"
};
const OWN_YARD_CODES = new Set(Object.keys(YARD_ADDRESSES));

function driverKey(value) {
  return String(value || "").trim().toLowerCase();
}

function planDateValue(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
}

function todayLocalDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
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
  const direct = (plan.orders || []).find((order) => String(order.id) === String(ref));
  if (direct) return direct;
  for (const order of plan.orders || []) {
    const child = (order.childOrderDetails || []).find((item) => String(item.id) === String(ref));
    if (child) return child;
  }
  return null;
}

function expandOrderRefs(plan, refs) {
  const expanded = [];
  const seen = new Set();
  const append = (ref) => {
    const id = String(ref || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    expanded.push(id);
  };
  refs.forEach((ref) => {
    const order = orderByRef(plan, ref);
    const children = Array.isArray(order?.childOrders) ? order.childOrders : [];
    if (children.length) {
      children.forEach(append);
      return;
    }
    append(ref);
  });
  return expanded;
}

function yardAddress(value) {
  return YARD_ADDRESSES[String(value || "")] || value || "";
}

function numberValue(value) {
  return Number(value || 0) || 0;
}

function positiveBalance(value, allocated) {
  return Math.max(numberValue(value) - numberValue(allocated), 0);
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
  const stopOrderRefs = [...new Set(relatedStops.map((item) => String(item.orderId || "")).filter(Boolean))];
  const orderRefs = expandOrderRefs(plan, stopOrderRefs);
  const firstOrder = orderByRef(plan, stopOrderRefs[0]) || orderByRef(plan, orderRefs[0]) || {};
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

function planJobsForTruck(plan, truck, truckIndex) {
  const jobs = [];
  (truck.loads || []).forEach((load, loadIndex) => {
    if (load.returnOnly) return;
    const travelJob = buildTravelJob(plan, truck, load, truckIndex, loadIndex);
    if (travelJob) jobs.push(travelJob);
    (load.stops || []).forEach((stop, stopIndex) => {
      if (!["pick", "drop"].includes(stop.type)) return;
      jobs.push(buildJob(plan, truck, load, stop, truckIndex, loadIndex, stopIndex));
    });
  });
  return jobs;
}

async function activeDriverAssignment(driverLogin) {
  const login = driverKey(driverLogin);
  const today = todayLocalDate();
  const matches = [];
  for (const plan of await confirmedPlans()) {
    if (plan.planDate < today) continue;
    (plan.trucks || []).forEach((truck, truckIndex) => {
      if (driverKey(truck.driverLogin || truck.driver) !== login) return;
      matches.push({ plan, truck, truckIndex });
    });
  }
  if (!matches.length) return null;
  return matches[0];
}

function dvirStatus(row, type) {
  if (!row) return "required";
  return type === "post"
    ? row.post_dvir_completed_at ? "complete" : "required"
    : row.pre_dvir_completed_at ? "complete" : "required";
}

function normalizedPlate(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function isSamsaraOnDutyConfirmed(row) {
  const response = row?.samsara_on_duty_response || {};
  const clock = response.clock || {};
  return Boolean(
    row?.on_duty_at
    && response.responseStatus === 200
    && clock.currentDutyStatus?.hosStatusType === "onDuty"
    && clock.currentVehicle?.id
  );
}

function isSamsaraDvirConfirmed(row, type = "pre") {
  const key = type === "post" ? "samsara_off_duty_response" : "samsara_on_duty_response";
  const response = row?.[key] || {};
  const dvir = response.dvir || response.verifiedDvir || {};
  const dvirVehicleId = String(dvir.vehicle?.id || "");
  const dvirPlate = normalizedPlate(dvir.licensePlate || dvir.vehicle?.licensePlate || response.dvir?.licensePlate || "");
  const currentPlate = normalizedPlate(row?.truck_plate || "");
  if (!(dvir.id || response.dvirId)) return false;
  if (currentPlate && dvirPlate !== currentPlate) return false;
  if (row?.samsara_vehicle_id && dvirVehicleId && dvirVehicleId !== String(row.samsara_vehicle_id)) return false;
  return true;
}

function isSamsaraOffDutyConfirmed(row) {
  const response = row?.samsara_off_duty_response || {};
  const clock = response.clock || {};
  return Boolean(
    row?.off_duty_at
    && response.responseStatus === 200
    && clock.currentDutyStatus?.hosStatusType === "offDuty"
  );
}

async function upsertDriverDayBase({ driverLogin, plan, truck, samsaraUsername = "" }) {
  const login = driverKey(driverLogin);
  const planDate = plan?.planDate || todayLocalDate();
  const existing = await query(
    `SELECT *
       FROM driver_day_records
      WHERE driver_login = $1
        AND plan_date = $2::date
      LIMIT 1`,
    [login, planDate]
  );
  const existingRow = existing.rows[0] || null;
  const truckChanged = existingRow && (
    String(existingRow.truck_id || "") !== String(truck?.id || "")
    || String(existingRow.truck_plate || "") !== String(truck?.plate || "")
    || String(existingRow.plan_id || "") !== String(plan?.id || "")
  );
  const result = await query(
    `INSERT INTO driver_day_records (
       driver_login, plan_id, plan_date, truck_id, truck_plate, samsara_username
     ) VALUES ($1, $2, $3::date, $4, $5, $6)
     ON CONFLICT (driver_login, plan_date) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       truck_id = EXCLUDED.truck_id,
       truck_plate = EXCLUDED.truck_plate,
       samsara_username = COALESCE(NULLIF(EXCLUDED.samsara_username, ''), driver_day_records.samsara_username),
       pre_dvir_photo_data_urls = CASE WHEN $7 = true THEN '[]'::jsonb ELSE driver_day_records.pre_dvir_photo_data_urls END,
       post_dvir_photo_data_urls = CASE WHEN $7 = true THEN '[]'::jsonb ELSE driver_day_records.post_dvir_photo_data_urls END,
       pre_dvir_completed_at = CASE WHEN $7 = true THEN NULL ELSE driver_day_records.pre_dvir_completed_at END,
       post_dvir_completed_at = CASE WHEN $7 = true THEN NULL ELSE driver_day_records.post_dvir_completed_at END,
       on_duty_at = CASE WHEN $7 = true THEN NULL ELSE driver_day_records.on_duty_at END,
       off_duty_at = CASE WHEN $7 = true THEN NULL ELSE driver_day_records.off_duty_at END,
       samsara_driver_id = CASE WHEN $7 = true THEN NULL ELSE driver_day_records.samsara_driver_id END,
       samsara_vehicle_id = CASE WHEN $7 = true THEN NULL ELSE driver_day_records.samsara_vehicle_id END,
       samsara_assignment_response = CASE WHEN $7 = true THEN '{}'::jsonb ELSE driver_day_records.samsara_assignment_response END,
       samsara_on_duty_response = CASE WHEN $7 = true THEN '{}'::jsonb ELSE driver_day_records.samsara_on_duty_response END,
       samsara_off_duty_response = CASE WHEN $7 = true THEN '{}'::jsonb ELSE driver_day_records.samsara_off_duty_response END,
       updated_at = now()
     RETURNING *`,
    [
      login,
      plan?.id || null,
      planDate,
      truck?.id || "",
      truck?.plate || "",
      samsaraUsername || "",
      Boolean(truckChanged)
    ]
  );
  return result.rows[0];
}

async function clearUnconfirmedDvirIfNeeded(row) {
  const clearPre = Boolean(row?.pre_dvir_completed_at && !isSamsaraDvirConfirmed(row, "pre"));
  const clearPost = Boolean(row?.post_dvir_completed_at && !isSamsaraDvirConfirmed(row, "post"));
  if (!clearPre && !clearPost) return row;
  const result = await query(
    `UPDATE driver_day_records
        SET pre_dvir_photo_data_urls = CASE WHEN $2 = true THEN '[]'::jsonb ELSE pre_dvir_photo_data_urls END,
            pre_dvir_completed_at = CASE WHEN $2 = true THEN NULL ELSE pre_dvir_completed_at END,
            on_duty_at = CASE WHEN $2 = true THEN NULL ELSE on_duty_at END,
            samsara_driver_id = CASE WHEN $2 = true THEN NULL ELSE samsara_driver_id END,
            samsara_vehicle_id = CASE WHEN $2 = true THEN NULL ELSE samsara_vehicle_id END,
            samsara_assignment_response = CASE WHEN $2 = true THEN '{}'::jsonb ELSE samsara_assignment_response END,
            samsara_on_duty_response = CASE WHEN $2 = true THEN '{}'::jsonb ELSE samsara_on_duty_response END,
            post_dvir_photo_data_urls = CASE WHEN $3 = true THEN '[]'::jsonb ELSE post_dvir_photo_data_urls END,
            post_dvir_completed_at = CASE WHEN $3 = true THEN NULL ELSE post_dvir_completed_at END,
            off_duty_at = CASE WHEN $3 = true THEN NULL ELSE off_duty_at END,
            samsara_off_duty_response = CASE WHEN $3 = true THEN '{}'::jsonb ELSE samsara_off_duty_response END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [row.id, clearPre, clearPost || clearPre]
  );
  return result.rows[0] || row;
}

export async function getDriverDayState(driverLogin, { samsaraUsername = "" } = {}) {
  const assignment = await activeDriverAssignment(driverLogin);
  const plan = assignment?.plan || { id: null, planDate: todayLocalDate() };
  const truck = assignment?.truck || {};
  let row = await upsertDriverDayBase({ driverLogin, plan, truck, samsaraUsername });
  row = await clearUnconfirmedDvirIfNeeded(row);
  const jobs = assignment ? planJobsForTruck(plan, truck, assignment.truckIndex) : [];
  const jobIds = jobs.map((job) => job.jobId);
  const completed = await completedJobIds(jobIds);
  const allJobsComplete = jobs.length > 0 && jobs.every((job) => completed.has(job.jobId));
  return {
    planId: plan?.id || null,
    planDate: plan?.planDate || todayLocalDate(),
    truckId: truck?.id || "",
    truckPlate: truck?.plate || "",
    parkingSpot: truck?.parkingSpot || "",
    samsaraUsername: row.samsara_username || samsaraUsername || "",
    preDvirStatus: dvirStatus(row, "pre") === "complete" && isSamsaraDvirConfirmed(row, "pre") ? "complete" : "required",
    postDvirStatus: dvirStatus(row, "post") === "complete" && isSamsaraDvirConfirmed(row, "post") ? "complete" : "required",
    preDvirCompletedAt: row.pre_dvir_completed_at || null,
    postDvirCompletedAt: row.post_dvir_completed_at || null,
    onDutyAt: row.on_duty_at || null,
    offDutyAt: row.off_duty_at || null,
    samsaraOnDutyConfirmed: isSamsaraOnDutyConfirmed(row),
    samsaraOffDutyConfirmed: isSamsaraOffDutyConfirmed(row),
    samsaraPreDvirConfirmed: isSamsaraDvirConfirmed(row, "pre"),
    samsaraPostDvirConfirmed: isSamsaraDvirConfirmed(row, "post"),
    samsaraOnDutyError: row.samsara_on_duty_response?.error || row.samsara_on_duty_response?.clockError || "",
    samsaraOffDutyError: row.samsara_off_duty_response?.error || row.samsara_off_duty_response?.clockError || "",
    allJobsComplete,
    jobCount: jobs.length,
    completedJobCount: completed.size
  };
}

export async function submitDriverDvir(driverLogin, { type = "pre", photoDataUrls = [], samsaraUsername = "", samsaraDvirAuthorId = "" } = {}) {
  const assignment = await activeDriverAssignment(driverLogin);
  const plan = assignment?.plan || { id: null, planDate: todayLocalDate() };
  const truck = assignment?.truck || {};
  if (!truck?.plate) throw new Error("No assigned truck was found in the confirmed dispatch plan.");
  let row = await upsertDriverDayBase({ driverLogin, plan, truck, samsaraUsername });
  const photos = Array.isArray(photoDataUrls) ? photoDataUrls.filter(Boolean) : [];
  if (photos.length < 4) throw new Error("4 inspection photos are required.");
  let samsaraAssignment = null;
  let samsaraDuty = null;
  let samsaraDvir = null;
  let verifiedDvir = null;
  let samsaraError = "";
  try {
    if (type === "pre" && samsaraUsername) {
      samsaraAssignment = await createSamsaraDriverVehicleAssignment({
        username: samsaraUsername,
        vehiclePlate: truck.plate
      });
      samsaraDuty = await setSamsaraDriverDutyStatus({
        username: samsaraUsername,
        vehicleId: samsaraAssignment.vehicle?.id || "",
        dutyStatus: "ON_DUTY",
        remark: `MBBS pre-DVIR complete with ${truck.plate}`
      });
      samsaraDvir = await createSamsaraMechanicDvir({
        authorId: samsaraDvirAuthorId || config.samsara.dvirAuthorId || "",
        vehicleId: samsaraAssignment.vehicle?.id || "",
        licensePlate: truck.plate,
        location: truck.base || truck.parkingSpot || "",
        safetyStatus: "safe",
        mechanicNotes: `MBBS pre-trip inspection submitted from Driver PWA by ${samsaraUsername}. Four photos are stored in MBBS.`
      });
      verifiedDvir = await findSamsaraDvirForVehicle({
        vehicleId: samsaraAssignment.vehicle?.id || "",
        sinceTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        type: "mechanic"
      });
      if (!verifiedDvir && !samsaraDvir?.dvir?.id) {
        throw new Error("Samsara DVIR was not found after submission. Please redo the inspection in MBBS.");
      }
    }
    if (type === "post" && samsaraUsername) {
      samsaraDuty = await setSamsaraDriverDutyStatus({
        username: samsaraUsername,
        dutyStatus: "OFF_DUTY",
        remark: `MBBS post-DVIR complete with ${truck.plate}`
      });
      const vehicleId = row.samsara_vehicle_id || "";
      samsaraDvir = await createSamsaraMechanicDvir({
        authorId: samsaraDvirAuthorId || config.samsara.dvirAuthorId || "",
        vehicleId,
        licensePlate: truck.plate,
        location: truck.base || truck.parkingSpot || "",
        safetyStatus: "safe",
        mechanicNotes: `MBBS post-trip inspection submitted from Driver PWA by ${samsaraUsername}. Four photos are stored in MBBS.`
      });
      verifiedDvir = await findSamsaraDvirForVehicle({
        vehicleId,
        sinceTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        type: "mechanic"
      });
      if (!verifiedDvir && !samsaraDvir?.dvir?.id) {
        throw new Error("Samsara DVIR was not found after submission. Please redo the inspection in MBBS.");
      }
    }
  } catch (error) {
    samsaraError = error.message;
  }
  const samsaraConfirmed = Boolean(samsaraDuty && !samsaraError && (verifiedDvir || samsaraDvir?.dvir?.id));
  const dvirPayload = {
    ...(samsaraDuty || {}),
    ...(samsaraError ? { error: samsaraError } : {}),
    dvir: samsaraDvir?.dvir || null,
    dvirId: samsaraDvir?.dvir?.id || verifiedDvir?.id || "",
    verifiedDvir: verifiedDvir || null
  };
  const result = await query(
    type === "post"
      ? `UPDATE driver_day_records
            SET post_dvir_photo_data_urls = CASE WHEN $4 = true THEN $2::jsonb ELSE post_dvir_photo_data_urls END,
                post_dvir_completed_at = CASE WHEN $4 = true THEN now() ELSE post_dvir_completed_at END,
                off_duty_at = CASE WHEN $4 = true THEN now() ELSE off_duty_at END,
                samsara_off_duty_response = $3::jsonb,
                updated_at = now()
          WHERE id = $1
          RETURNING *`
      : `UPDATE driver_day_records
            SET pre_dvir_photo_data_urls = CASE WHEN $7 = true THEN $2::jsonb ELSE '[]'::jsonb END,
                pre_dvir_completed_at = CASE WHEN $7 = true THEN now() ELSE NULL END,
                on_duty_at = CASE WHEN $7 = true THEN now() ELSE NULL END,
                samsara_driver_id = COALESCE(NULLIF($4, ''), samsara_driver_id),
                samsara_vehicle_id = COALESCE(NULLIF($5, ''), samsara_vehicle_id),
                samsara_assignment_response = $6::jsonb,
                samsara_on_duty_response = $3::jsonb,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
    type === "post"
      ? [
          row.id,
          JSON.stringify(photos),
          JSON.stringify(dvirPayload),
          samsaraConfirmed
        ]
      : [
          row.id,
          JSON.stringify(photos),
          JSON.stringify(dvirPayload),
          samsaraAssignment?.driver?.id || "",
          samsaraAssignment?.vehicle?.id || "",
          JSON.stringify(samsaraAssignment || (samsaraError ? { error: samsaraError } : {})),
          samsaraConfirmed
        ]
  );
  row = result.rows[0];
  return {
    state: await getDriverDayState(driverLogin, { samsaraUsername }),
    samsaraError,
    samsaraAssignment,
    samsaraDuty,
    samsaraDvir,
    verifiedDvir,
    recordId: row.id
  };
}

export async function skipDriverDvirForTesting(driverLogin, { type = "pre", samsaraUsername = "" } = {}) {
  const assignment = await activeDriverAssignment(driverLogin);
  const plan = assignment?.plan || { id: null, planDate: todayLocalDate() };
  const truck = assignment?.truck || {};
  if (!truck?.plate) throw new Error("No assigned truck was found in the confirmed dispatch plan.");
  const row = await upsertDriverDayBase({ driverLogin, plan, truck, samsaraUsername });
  const fakeDvir = {
    responseStatus: 200,
    skippedForTesting: true,
    dvirId: `MBBS-SKIP-${type}-${Date.now()}`,
    dvir: {
      id: `MBBS-SKIP-${type}-${Date.now()}`,
      licensePlate: truck.plate,
      vehicle: {
        id: "mbbs-test-skip",
        licensePlate: truck.plate
      }
    },
    verifiedDvir: {
      id: `MBBS-SKIP-${type}-${Date.now()}`,
      licensePlate: truck.plate,
      vehicle: {
        id: "mbbs-test-skip",
        licensePlate: truck.plate
      }
    },
    clock: {
      currentDutyStatus: {
        hosStatusType: type === "post" ? "offDuty" : "onDuty"
      },
      currentVehicle: {
        id: "mbbs-test-skip"
      }
    }
  };
  const photos = JSON.stringify([]);
  const result = type === "post"
    ? await query(
        `UPDATE driver_day_records
            SET samsara_username = COALESCE(NULLIF($2, ''), samsara_username),
                post_dvir_photo_data_urls = $3::jsonb,
                post_dvir_completed_at = now(),
                off_duty_at = now(),
                samsara_vehicle_id = 'mbbs-test-skip',
                samsara_off_duty_response = $4::jsonb,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [row.id, samsaraUsername || "", photos, JSON.stringify(fakeDvir)]
      )
    : await query(
        `UPDATE driver_day_records
            SET samsara_username = COALESCE(NULLIF($2, ''), samsara_username),
                pre_dvir_photo_data_urls = $3::jsonb,
                pre_dvir_completed_at = now(),
                on_duty_at = now(),
                samsara_driver_id = COALESCE(samsara_driver_id, 'mbbs-test-skip'),
                samsara_vehicle_id = 'mbbs-test-skip',
                samsara_assignment_response = $4::jsonb,
                samsara_on_duty_response = $4::jsonb,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [row.id, samsaraUsername || "", photos, JSON.stringify(fakeDvir)]
      );
  return {
    state: await getDriverDayState(driverLogin, { samsaraUsername }),
    recordId: result.rows[0]?.id || row.id,
    skippedForTesting: true
  };
}

async function detailsFromDelivery(orderRef, typeHint = "", context = {}) {
  const typeClause = typeHint === "TO" ? "AND o.order_type = 'transfer_order'" : typeHint === "SO" ? "AND o.order_type = 'sales_order'" : "";
  const order = await query(
    `WITH delivery_order_source AS (
       SELECT netsuite_id, tranid, 'sales_order'::text AS order_type, customer AS party,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              NULL::text AS destination_location, outbound_location, synced_at
       FROM sales_orders
       UNION ALL
       SELECT netsuite_id, tranid, 'transfer_order'::text AS order_type, to_location AS party,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              to_location AS destination_location, from_location AS outbound_location, synced_at
       FROM transfer_orders
       WHERE from_location_id IS NOT NULL
     )
     SELECT o.netsuite_id, o.tranid, o.order_type, o.party,
            o.dispatch_address, o.dispatch_window_start, o.dispatch_window_end, o.destination_location,
            o.outbound_location
       FROM delivery_order_source o
      WHERE o.tranid = $1 ${typeClause}
      ORDER BY o.synced_at DESC
      LIMIT 1`,
    [orderRef]
  );
  if (!order.rowCount) return null;
  const pickupLocation = String(context.pickupLocation || "").trim();
  const lines = await query(
    `WITH alloc_total AS (
       SELECT sales_line_id,
              SUM(allocated_pallet_qty) AS allocated_pallet_qty,
              SUM(allocated_layer_qty) AS allocated_layer_qty,
              SUM(allocated_section_qty) AS allocated_section_qty,
              SUM(allocated_piece_qty) AS allocated_piece_qty,
              SUM(allocated_sales_qty) AS allocated_sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY sales_line_id
     ),
     alloc_location AS (
       SELECT a.sales_line_id,
              SUM(a.allocated_pallet_qty) AS allocated_pallet_qty,
              SUM(a.allocated_layer_qty) AS allocated_layer_qty,
              SUM(a.allocated_section_qty) AS allocated_section_qty,
              SUM(a.allocated_piece_qty) AS allocated_piece_qty,
              SUM(a.allocated_sales_qty) AS allocated_sales_qty
         FROM dispatch_so_po_allocations a
         JOIN purchase_orders po ON po.netsuite_id = a.po_order_id
        WHERE a.status = 'active'
          AND $2 <> ''
          AND LOWER(COALESCE(NULLIF(po.dispatch_vendor_yard, ''), NULLIF(po.source_location, ''), NULLIF(po.vendor, ''))) = LOWER($2)
        GROUP BY a.sales_line_id
     )
     SELECT l.item_name, l.sku, l.item_description, l.item_type, l.quantity, l.unit,
            l.pallet_qty, l.layer_qty, l.section_qty, l.piece_qty,
            COALESCE(at.allocated_pallet_qty, 0) AS total_allocated_pallet_qty,
            COALESCE(at.allocated_layer_qty, 0) AS total_allocated_layer_qty,
            COALESCE(at.allocated_section_qty, 0) AS total_allocated_section_qty,
            COALESCE(at.allocated_piece_qty, 0) AS total_allocated_piece_qty,
            COALESCE(at.allocated_sales_qty, 0) AS total_allocated_sales_qty,
            COALESCE(al.allocated_pallet_qty, 0) AS location_allocated_pallet_qty,
            COALESCE(al.allocated_layer_qty, 0) AS location_allocated_layer_qty,
            COALESCE(al.allocated_section_qty, 0) AS location_allocated_section_qty,
            COALESCE(al.allocated_piece_qty, 0) AS location_allocated_piece_qty,
            COALESCE(al.allocated_sales_qty, 0) AS location_allocated_sales_qty
       FROM (
         SELECT sales_order_id AS order_id, id, line_id, item_name, sku, item_description, item_type,
                quantity, unit, pallet_qty, layer_qty, section_qty, piece_qty, netsuite_active
         FROM sales_order_lines
         UNION ALL
         SELECT transfer_order_id AS order_id, id, line_id, item_name, sku, item_description, item_type,
                quantity, unit, pallet_qty, layer_qty, section_qty, piece_qty, netsuite_active
         FROM transfer_order_lines
         WHERE line_stage = 'outbound'
       ) l
       LEFT JOIN alloc_total at ON at.sales_line_id = l.id
       LEFT JOIN alloc_location al ON al.sales_line_id = l.id
      WHERE order_id = $1
        AND netsuite_active = true
      ORDER BY line_id NULLS LAST, id`,
    [order.rows[0].netsuite_id, pickupLocation]
  );
  if (context.stopType !== "pickup" || order.rows[0].order_type !== "sales_order") {
    return { ...order.rows[0], source: "delivery", lines: lines.rows };
  }
  const ownPickup = !pickupLocation || OWN_YARD_CODES.has(pickupLocation) || String(order.rows[0].outbound_location || "") === pickupLocation;
  const adjustedLines = lines.rows.map((line) => ownPickup
    ? {
        ...line,
        pallet_qty: positiveBalance(line.pallet_qty, line.total_allocated_pallet_qty),
        layer_qty: positiveBalance(line.layer_qty, line.total_allocated_layer_qty),
        section_qty: positiveBalance(line.section_qty, line.total_allocated_section_qty),
        piece_qty: positiveBalance(line.piece_qty, line.total_allocated_piece_qty),
        quantity: positiveBalance(line.quantity, line.total_allocated_sales_qty)
      }
    : {
        ...line,
        pallet_qty: numberValue(line.location_allocated_pallet_qty),
        layer_qty: numberValue(line.location_allocated_layer_qty),
        section_qty: numberValue(line.location_allocated_section_qty),
        piece_qty: numberValue(line.location_allocated_piece_qty),
        quantity: numberValue(line.location_allocated_sales_qty)
      })
    .filter((line) => numberValue(line.pallet_qty) || numberValue(line.layer_qty) || numberValue(line.section_qty) || numberValue(line.piece_qty) || numberValue(line.quantity));
  return { ...order.rows[0], source: "delivery", lines: adjustedLines };
}

async function detailsFromReceiving(orderRef, typeHint = "") {
  const typeClause = typeHint === "TO" ? "AND o.order_type = 'transfer_order'" : typeHint === "PO" ? "AND o.order_type = 'purchase_order'" : "";
  const order = await query(
    `WITH receiving_order_source AS (
       SELECT netsuite_id, tranid, 'purchase_order'::text AS order_type, vendor AS party,
              dispatch_address, dispatch_window_start, dispatch_window_end, destination_location, synced_at
       FROM purchase_orders
       UNION ALL
       SELECT netsuite_id, tranid, 'transfer_order'::text AS order_type, from_location AS party,
              dispatch_address, dispatch_window_start, dispatch_window_end, to_location AS destination_location, synced_at
       FROM transfer_orders
       WHERE to_location_id IS NOT NULL
     )
     SELECT o.netsuite_id, o.tranid, o.order_type, o.party,
            o.dispatch_address, o.dispatch_window_start, o.dispatch_window_end, o.destination_location
       FROM receiving_order_source o
      WHERE o.tranid = $1 ${typeClause}
      ORDER BY o.synced_at DESC
      LIMIT 1`,
    [orderRef]
  );
  if (!order.rowCount) return null;
  const lines = await query(
    `SELECT item_name, sku, item_description, item_type, quantity, unit,
            pallet_qty, layer_qty, section_qty, piece_qty
       FROM (
         SELECT purchase_order_id AS order_id, line_id, id, item_name, sku, item_description, item_type,
                quantity, unit, pallet_qty, layer_qty, section_qty, piece_qty, netsuite_active
         FROM purchase_order_lines
         UNION ALL
         SELECT transfer_order_id AS order_id, line_id, id, item_name, sku, item_description, item_type,
                quantity, unit, pallet_qty, layer_qty, section_qty, piece_qty, netsuite_active
         FROM transfer_order_lines
         WHERE line_stage = 'receiving'
       ) receiving_lines
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
       FROM co_orders
      WHERE co_ref = $1
      LIMIT 1`,
    [orderRef]
  );
  if (!order.rowCount) return null;
  const lines = await query(
    `SELECT item_name, sku, item_description, item_type, quantity, unit,
            pallet_qty, layer_qty, section_qty, piece_qty
       FROM co_order_lines
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

function visibleUnitsFromPlanItem(item) {
  const values = [
    ["PLT", item.pallets ?? item.pallet_qty],
    ["LYR", item.layers ?? item.layer_qty],
    ["SEC", item.sections ?? item.section_qty],
    ["PCS", item.pieces ?? item.piece_qty]
  ].filter(([, value]) => Number(value || 0) > 0);
  if (values.length) return values.map(([unit, value]) => ({ unit, value: Number(value) }));
  return [{ unit: item.unit || "UOM", value: Number(item.quantity || item.salesQty || 0), fallback: true }];
}

function planItemForPickup(item, context = {}) {
  if (context.stopType !== "pickup") return item;
  const pickupLocation = String(context.pickupLocation || "").trim();
  const ownPickup = !pickupLocation || OWN_YARD_CODES.has(pickupLocation);
  if (ownPickup) {
    return {
      ...item,
      pallets: positiveBalance(item.pallets, item.poAllocatedPallets),
      layers: positiveBalance(item.layers, item.poAllocatedLayers),
      sections: positiveBalance(item.sections, item.poAllocatedSections),
      pieces: positiveBalance(item.pieces, item.poAllocatedPieces),
      quantity: positiveBalance(item.quantity ?? item.salesQty, item.poAllocatedSalesQty),
      salesQty: positiveBalance(item.salesQty ?? item.quantity, item.poAllocatedSalesQty)
    };
  }
  return {
    ...item,
    pallets: numberValue(item.poAllocatedPallets),
    layers: numberValue(item.poAllocatedLayers),
    sections: numberValue(item.poAllocatedSections),
    pieces: numberValue(item.poAllocatedPieces),
    quantity: numberValue(item.poAllocatedSalesQty),
    salesQty: numberValue(item.poAllocatedSalesQty)
  };
}

function planItemHasQuantity(item) {
  return numberValue(item.pallets ?? item.pallet_qty)
    || numberValue(item.layers ?? item.layer_qty)
    || numberValue(item.sections ?? item.section_qty)
    || numberValue(item.pieces ?? item.piece_qty)
    || numberValue(item.quantity || item.salesQty);
}

function isMaterialLine(line) {
  const itemType = String(line.item_type || "").trim();
  if (!itemType) return true;
  return ["InvtPart", "NonInvtPart"].includes(itemType);
}

function orderDetailsFromPlan(orderRef, planOrder = null, context = {}) {
  const items = (planOrder?.items || [])
    .map((item) => planItemForPickup(item, context))
    .filter(planItemHasQuantity);
  return {
    orderRef,
    party: planOrder?.customer || planOrder?.vendor || planOrder?.party || "",
    source: "dispatch_plan",
    items: items.map((item) => ({
      itemName: item.itemName || item.name || item.sku || "",
      sku: item.sku || item.itemName || item.name || "",
      description: item.description || item.itemDescription || "",
      units: visibleUnitsFromPlanItem(item)
    }))
  };
}

async function orderDetails(orderRef, typeHint = "", planOrder = null, context = {}) {
  const detail = typeHint === "PO"
    ? await detailsFromReceiving(orderRef, "PO")
    : typeHint === "CO"
      ? await detailsFromLocalCo(orderRef)
      : typeHint === "TO"
        ? await detailsFromDelivery(orderRef, "TO", context) || await detailsFromReceiving(orderRef, "TO")
        : await detailsFromDelivery(orderRef, "SO", context) || await detailsFromReceiving(orderRef) || await detailsFromLocalCo(orderRef);
  if (!detail) return orderDetailsFromPlan(orderRef, planOrder, context);
  const items = (detail.lines || []).filter(isMaterialLine).map((line) => ({
    itemName: line.item_name || line.sku || "",
    sku: line.sku || line.item_name || "",
    description: line.item_description || "",
    units: visibleUnits(line)
  }));
  if (!items.length && planOrder?.items?.length) return orderDetailsFromPlan(orderRef, planOrder, context);
  return {
    orderRef,
    party: detail.party || "",
    source: detail.source,
    items
  };
}

export async function getNextDriverJob(driverLogin) {
  const assignment = await activeDriverAssignment(driverLogin);
  if (!assignment) return null;
  const jobs = planJobsForTruck(assignment.plan, assignment.truck, assignment.truckIndex);
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
    return orderDetails(ref, hint, orderByRef(assignment.plan, ref), {
      stopType: next.stopType,
      pickupLocation: next.stopType === "pickup" ? next.location : ""
    });
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

export async function listDriverHistory(driverLogin, { date = "", limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const login = driverKey(driverLogin);
  const records = [];

  const dayParams = [login];
  const dayDateClause = date ? " AND plan_date = $2::date" : "";
  if (date) dayParams.push(String(date).slice(0, 10));
  const dayResult = await query(
    `SELECT id, driver_login, plan_id, plan_date::text AS plan_date,
            truck_id, truck_plate, samsara_username,
            COALESCE(pre_dvir_photo_data_urls, '[]'::jsonb) AS pre_photos,
            COALESCE(post_dvir_photo_data_urls, '[]'::jsonb) AS post_photos,
            pre_dvir_completed_at, post_dvir_completed_at,
            COALESCE(samsara_on_duty_response, '{}'::jsonb) AS samsara_on_response,
            COALESCE(samsara_off_duty_response, '{}'::jsonb) AS samsara_off_response,
            updated_at
       FROM driver_day_records
      WHERE driver_login = $1
        ${dayDateClause}
      ORDER BY COALESCE(post_dvir_completed_at, pre_dvir_completed_at, updated_at) DESC
      LIMIT ${safeLimit}`,
    dayParams
  );
  for (const row of dayResult.rows) {
    const prePhotos = Array.isArray(row.pre_photos) ? row.pre_photos.filter(Boolean) : [];
    if (row.pre_dvir_completed_at || prePhotos.length) {
      records.push({
        id: `dvir-pre-${row.id}`,
        type: "pre_dvir",
        title: "Pre-Trip DVIR",
        reference: row.truck_plate || "",
        planDate: row.plan_date || "",
        truckPlate: row.truck_plate || "",
        status: row.pre_dvir_completed_at ? "complete" : "photos saved",
        createdAt: row.pre_dvir_completed_at || row.updated_at,
        photos: prePhotos,
        details: {
          planId: row.plan_id,
          samsaraUsername: row.samsara_username,
          samsaraDvirId: row.samsara_on_response?.dvirId || row.samsara_on_response?.dvir?.id || row.samsara_on_response?.verifiedDvir?.id || "",
          samsaraError: row.samsara_on_response?.error || row.samsara_on_response?.clockError || ""
        }
      });
    }
    const postPhotos = Array.isArray(row.post_photos) ? row.post_photos.filter(Boolean) : [];
    if (row.post_dvir_completed_at || postPhotos.length) {
      records.push({
        id: `dvir-post-${row.id}`,
        type: "post_dvir",
        title: "Post-Trip DVIR",
        reference: row.truck_plate || "",
        planDate: row.plan_date || "",
        truckPlate: row.truck_plate || "",
        status: row.post_dvir_completed_at ? "complete" : "photos saved",
        createdAt: row.post_dvir_completed_at || row.updated_at,
        photos: postPhotos,
        details: {
          planId: row.plan_id,
          samsaraUsername: row.samsara_username,
          samsaraDvirId: row.samsara_off_response?.dvirId || row.samsara_off_response?.dvir?.id || row.samsara_off_response?.verifiedDvir?.id || "",
          samsaraError: row.samsara_off_response?.error || row.samsara_off_response?.clockError || ""
        }
      });
    }
  }

  const jobParams = [login];
  const jobDateClause = date ? " AND plan_date = $2::date" : "";
  if (date) jobParams.push(String(date).slice(0, 10));
  const jobResult = await query(
    `SELECT id, job_id, plan_id, plan_date::text AS plan_date,
            truck_id, truck_plate, load_id, load_name, stop_id, stop_type,
            COALESCE(order_refs, '[]'::jsonb) AS order_refs,
            COALESCE(photo_data_urls, '[]'::jsonb) AS photos,
            status, started_at, completed_at, created_at
       FROM driver_job_records
      WHERE driver_login = $1
        AND (status = 'complete' OR photo_data_urls::text LIKE '%r2://%')
        ${jobDateClause}
      ORDER BY COALESCE(completed_at, started_at, created_at) DESC, id DESC
      LIMIT ${safeLimit}`,
    jobParams
  );
  for (const row of jobResult.rows) {
    const photos = Array.isArray(row.photos) ? row.photos.filter(Boolean) : [];
    records.push({
      id: `job-${row.id}`,
      type: "stop",
      title: row.stop_type === "pickup" ? "Pickup Stop" : row.stop_type === "dropoff" ? "Drop Off Stop" : "Travel Stop",
      reference: Array.isArray(row.order_refs) ? row.order_refs.join(", ") : "",
      planDate: row.plan_date || "",
      truckPlate: row.truck_plate || "",
      status: row.status || "",
      createdAt: row.completed_at || row.started_at || row.created_at,
      photos,
      details: {
        jobId: row.job_id,
        planId: row.plan_id,
        loadName: row.load_name,
        stopType: row.stop_type,
        orderRefs: row.order_refs || [],
        startedAt: row.started_at,
        completedAt: row.completed_at
      }
    });
  }

  return records
    .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0))
    .slice(0, safeLimit);
}
