const QUANTITY_TOLERANCE = 0.000001;
const LOAD_MATCH_TOLERANCE = 0.1;
const RELOAD_REASON_MAX_LENGTH = 500;
const RELOAD_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reloadError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function roundQuantity(value) {
  return Number(number(value).toFixed(6));
}

function positiveInteger(value, label, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw reloadError(`${label} is invalid.`, code, 400);
  }
  return parsed;
}

function firstDefined(source, keys, fallback = null) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return source[key];
  }
  return fallback;
}

function compactStatus(value) {
  return String(value || "")
    .trim()
    .replace(/\s*:\s*/g, ":")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isPickableLine(line) {
  return ["InvtPart", "NonInvtPart"].includes(String(line?.item_type || line?.itemType || ""));
}

function lineValue(line, snake, camel = "") {
  return firstDefined(line, camel ? [snake, camel] : [snake], null);
}

function deriveLoadedUnits(line, loadedSalesQty) {
  let remaining = number(loadedSalesQty);
  const values = {};
  for (const definition of [
    ["Pallet", "pallet_qty", "palletQty", "to_plt", "toPlt"],
    ["Layer", "layer_qty", "layerQty", "to_lyr", "toLyr"],
    ["Section", "section_qty", "sectionQty", "to_sec", "toSec"],
    ["Piece", "piece_qty", "pieceQty", "to_pcs", "toPcs"]
  ]) {
    const [label, requiredSnake, requiredCamel, conversionSnake, conversionCamel] = definition;
    const required = number(lineValue(line, requiredSnake, requiredCamel));
    const conversion = number(lineValue(line, conversionSnake, conversionCamel));
    let consumed = 0;
    if (required > 0 && conversion > 0 && remaining > QUANTITY_TOLERANCE) {
      consumed = Math.min(required, Math.floor((remaining / conversion) + QUANTITY_TOLERANCE));
      const ceil = Math.min(required, Math.ceil((remaining / conversion) - QUANTITY_TOLERANCE));
      if (ceil > consumed && Math.abs((ceil * conversion) - remaining) <= LOAD_MATCH_TOLERANCE) {
        consumed = ceil;
      }
      remaining = roundQuantity(Math.max(0, remaining - (consumed * conversion)));
    }
    values[`target${label}Qty`] = roundQuantity(consumed);
  }
  return { ...values, remainingSalesQty: remaining };
}

export function normalizeReloadReason(value) {
  const reason = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!reason) throw reloadError("A re-load reason is required.", "RELOAD_REASON_REQUIRED", 400);
  if (reason.length > RELOAD_REASON_MAX_LENGTH) {
    throw reloadError(
      `Re-load reason must be ${RELOAD_REASON_MAX_LENGTH} characters or fewer.`,
      "RELOAD_REASON_TOO_LONG",
      400
    );
  }
  return reason;
}

export function normalizeReloadRequestId(value) {
  const requestId = String(value || "").trim().toLowerCase();
  if (!RELOAD_REQUEST_ID_PATTERN.test(requestId)) {
    throw reloadError("A valid re-load request ID is required.", "RELOAD_REQUEST_ID_INVALID", 400);
  }
  return requestId;
}

export function buildSalesOrderReloadTargets(lines = []) {
  const targets = [];
  for (const line of lines || []) {
    const loadedSalesQty = roundQuantity(lineValue(line, "loaded_qty", "loadedQty"));
    if (loadedSalesQty <= QUANTITY_TOLERANCE || !isPickableLine(line)) continue;
    const active = firstDefined(line, ["netsuite_active", "netsuiteActive"], true) !== false;
    const syncException = String(firstDefined(line, ["sync_exception", "syncException"], "") || "").trim();
    const requiredSalesQty = roundQuantity(lineValue(line, "quantity", "quantity"));
    if (!active || syncException || (requiredSalesQty > 0 && loadedSalesQty > requiredSalesQty + LOAD_MATCH_TOLERANCE)) {
      throw reloadError(
        `${line.sku || line.item_name || line.itemName || "A loaded line"} conflicts with the latest NetSuite line.`,
        "RELOAD_LINE_CONFLICT"
      );
    }
    const units = deriveLoadedUnits(line, loadedSalesQty);
    const hasConversion = ["to_plt", "to_lyr", "to_sec", "to_pcs"]
      .some((key) => number(lineValue(line, key, key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()))) > 0);
    if (hasConversion && units.remainingSalesQty > LOAD_MATCH_TOLERANCE) {
      throw reloadError(
        `${line.sku || line.item_name || line.itemName || "A loaded line"} cannot be mapped back to its physical units.`,
        "RELOAD_LINE_CONFLICT"
      );
    }
    targets.push({
      salesOrderLineId: positiveInteger(firstDefined(line, ["id"]), "Sales Order line", "RELOAD_LINE_CONFLICT"),
      netsuiteLineId: Number(firstDefined(line, ["line_id", "lineId"], 0)) || null,
      itemId: Number(firstDefined(line, ["item_id", "itemId"], 0)) || null,
      itemName: String(firstDefined(line, ["item_name", "itemName"], "") || ""),
      sku: String(firstDefined(line, ["sku"], "") || ""),
      itemDescription: String(firstDefined(line, ["item_description", "itemDescription"], "") || ""),
      salesUom: String(firstDefined(line, ["loaded_uom", "loadedUom", "unit"], "") || ""),
      targetSalesQty: loadedSalesQty,
      targetPalletQty: units.targetPalletQty,
      targetLayerQty: units.targetLayerQty,
      targetSectionQty: units.targetSectionQty,
      targetPieceQty: units.targetPieceQty,
      toPlt: roundQuantity(lineValue(line, "to_plt", "toPlt")),
      toLyr: roundQuantity(lineValue(line, "to_lyr", "toLyr")),
      toSec: roundQuantity(lineValue(line, "to_sec", "toSec")),
      toPcs: roundQuantity(lineValue(line, "to_pcs", "toPcs"))
    });
  }
  return targets;
}

function packedStateValue(state, name) {
  const snake = name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return number(firstDefined(state, [name, snake], 0));
}

function requestedValue(requested, plural) {
  const singular = plural.endsWith("s") ? plural.slice(0, -1) : plural;
  return number(firstDefined(requested, [plural, singular], 0));
}

export function reloadPackedQuantities(target = {}, state = {}, requested = {}, { absolute = false } = {}) {
  const remainingSalesQty = roundQuantity(Math.max(
    0,
    number(target.targetSalesQty) - packedStateValue(state, "reloadedSalesQty")
  ));
  const conversions = {
    Pallet: number(target.toPlt),
    Layer: number(target.toLyr),
    Section: number(target.toSec),
    Piece: number(target.toPcs)
  };
  const hasConversion = Object.values(conversions).some((value) => value > 0);
  if (!hasConversion) {
    const current = packedStateValue(state, "packedSalesQty");
    const desired = absolute ? requestedValue(requested, "salesQty") : current + requestedValue(requested, "salesQty");
    const packedSalesQty = roundQuantity(Math.min(remainingSalesQty, desired));
    return {
      packedPalletQty: 0,
      packedLayerQty: 0,
      packedSectionQty: 0,
      packedPieceQty: 0,
      packedSalesQty,
      packedTotalSalesQty: packedSalesQty
    };
  }

  let salesCapacity = remainingSalesQty;
  const result = {};
  for (const [label, requestKey] of [
    ["Pallet", "pallets"],
    ["Layer", "layers"],
    ["Section", "sections"],
    ["Piece", "pieces"]
  ]) {
    const current = packedStateValue(state, `packed${label}Qty`);
    const desired = absolute ? requestedValue(requested, requestKey) : current + requestedValue(requested, requestKey);
    const reloadedUnits = packedStateValue(state, `reloaded${label}Qty`);
    const unitLimit = Math.max(0, number(target[`target${label}Qty`]) - reloadedUnits);
    const conversion = conversions[label];
    const bySales = conversion > 0 ? Math.floor((salesCapacity / conversion) + QUANTITY_TOLERANCE) : 0;
    const packed = roundQuantity(Math.min(desired, unitLimit, bySales));
    result[`packed${label}Qty`] = packed;
    salesCapacity = roundQuantity(Math.max(0, salesCapacity - (packed * conversion)));
  }
  const packedTotalSalesQty = roundQuantity(remainingSalesQty - salesCapacity);
  return {
    packedPalletQty: result.packedPalletQty,
    packedLayerQty: result.packedLayerQty,
    packedSectionQty: result.packedSectionQty,
    packedPieceQty: result.packedPieceQty,
    packedSalesQty: 0,
    packedTotalSalesQty
  };
}

export function assertSalesOrderReloadEligibility(snapshot = {}) {
  const order = snapshot.order || {};
  const orderId = Number(firstDefined(order, ["netsuite_id", "netsuiteId"], 0));
  const orderType = String(firstDefined(order, ["order_type", "orderType"], "") || "").toLowerCase();
  const orderRef = String(firstDefined(order, ["tranid", "orderRef"], "") || "");
  const deliveryMethod = String(firstDefined(order, ["delivery_method", "deliveryMethod"], "") || "");
  if (
    orderType !== "sales_order"
    || !Number.isInteger(orderId)
    || orderId <= 0
    || /-S\d+$/i.test(orderRef)
    || deliveryMethod.trim() === "Pick-Up"
  ) {
    throw reloadError("Only a real NetSuite delivery Sales Order can be re-loaded.", "RELOAD_NOT_DELIVERY_SO");
  }

  const status = compactStatus(order.status);
  const statusText = compactStatus(firstDefined(order, ["status_text", "statusText"], ""));
  const fulfillmentStatus = compactStatus(firstDefined(order, ["fulfillment_status", "fulfillmentStatus"], ""));
  const active = firstDefined(order, ["netsuite_active", "netsuiteActive"], true) !== false;
  const terminalText = `${status} ${statusText} ${fulfillmentStatus}`;
  const terminal = !active
    || status === "g"
    || fulfillmentStatus === "fulfilled"
    || /\b(billed|closed|cancelled|canceled|voided|fully fulfilled)\b/.test(terminalText);
  const pending = status === "b"
    || statusText.includes("pending fulfillment")
    || statusText.includes("partially fulfilled")
    || fulfillmentStatus === "partial_fulfilled";
  if (terminal || !pending) {
    throw reloadError("NetSuite no longer shows this Sales Order as incomplete.", "RELOAD_NETSUITE_COMPLETE");
  }
  if (number(snapshot.priorLoadCount) <= 0) {
    throw reloadError("This Sales Order has no prior local load record.", "RELOAD_NO_PRIOR_LOAD");
  }
  if (snapshot.completedDropoff) {
    throw reloadError("The driver drop-off is already complete.", "RELOAD_DRIVER_COMPLETE");
  }
  if (snapshot.activeCycle) {
    throw reloadError("This Sales Order already has an active re-load.", "RELOAD_ACTIVE");
  }
  if (snapshot.activeDraft || snapshot.activeConsolidation) {
    throw reloadError("Finish or release the active Operator work before authorizing a re-load.", "RELOAD_OPERATOR_ACTIVE");
  }
  const targets = buildSalesOrderReloadTargets(snapshot.lines || order.lines || []);
  if (!targets.length) {
    throw reloadError("This Sales Order has no locally loaded quantity to re-load.", "RELOAD_NO_LOADED_QUANTITY");
  }
  return { eligible: true, order, targets };
}

function actorId(actor) {
  const id = String(actor?.id || "").trim();
  if (!id) throw reloadError("A Control operator is required.", "RELOAD_ACTOR_REQUIRED", 401);
  return id;
}

function cycleOrderId(cycle) {
  return Number(firstDefined(cycle, ["salesOrderId", "sales_order_id"], 0));
}

export async function authorizeSalesOrderReload(input = {}, dependencies = {}) {
  const orderId = positiveInteger(input.orderId, "Sales Order", "RELOAD_ORDER_ID_INVALID");
  const requestId = normalizeReloadRequestId(input.requestId);
  const reason = normalizeReloadReason(input.reason);
  const actor = input.actor || {};
  actorId(actor);

  const existing = await dependencies.findCycleByRequestId(requestId);
  if (existing) {
    if (cycleOrderId(existing) !== orderId) {
      throw reloadError("Re-load request ID was already used for another order.", "RELOAD_REQUEST_ID_CONFLICT");
    }
    return existing;
  }

  const identity = await dependencies.findLocalOrderIdentity(orderId);
  if (!identity) throw reloadError("Sales Order was not found locally.", "RELOAD_ORDER_NOT_FOUND", 404);
  await dependencies.assertActorYardAccess(actor, Number(identity.outboundLocationId || identity.outbound_location_id));
  await dependencies.refreshOrder({ orderRef: identity.tranid || identity.orderRef, actor });

  return dependencies.withTransaction(async () => {
    const raced = await dependencies.findCycleByRequestId(requestId);
    if (raced) {
      if (cycleOrderId(raced) !== orderId) {
        throw reloadError("Re-load request ID was already used for another order.", "RELOAD_REQUEST_ID_CONFLICT");
      }
      return raced;
    }
    const snapshot = await dependencies.lockAuthorizationSnapshot(orderId);
    const eligibility = assertSalesOrderReloadEligibility(snapshot);
    const cycle = await dependencies.createCycle({
      order: eligibility.order,
      targets: eligibility.targets,
      reason,
      requestId,
      actor
    });
    await dependencies.writeAudit({
      actorOperatorId: actor.id,
      source: "control",
      action: "delivery.reload.authorize",
      orderId,
      details: {
        cycleId: cycle.id,
        reason,
        targetSalesQty: roundQuantity(eligibility.targets.reduce((sum, target) => sum + target.targetSalesQty, 0)),
        lineCount: eligibility.targets.length
      }
    });
    return cycle;
  });
}

export async function cancelSalesOrderReload(input = {}, dependencies = {}) {
  const orderId = positiveInteger(input.orderId, "Sales Order", "RELOAD_ORDER_ID_INVALID");
  const cycleId = positiveInteger(input.cycleId, "Re-load cycle", "RELOAD_CYCLE_ID_INVALID");
  const reason = normalizeReloadReason(input.reason);
  const actor = input.actor || {};
  actorId(actor);
  return dependencies.withTransaction(async () => {
    const cycle = await dependencies.lockCycle(cycleId);
    if (!cycle || cycleOrderId(cycle) !== orderId) {
      throw reloadError("Re-load cycle was not found.", "RELOAD_CYCLE_NOT_FOUND", 404);
    }
    const status = String(cycle.status || "").toLowerCase();
    if (status === "cancelled") return cycle;
    const activityStartedAt = firstDefined(cycle, ["activityStartedAt", "activity_started_at"], null);
    if (activityStartedAt || status !== "authorized") {
      throw reloadError("This re-load already has Operator activity and cannot be cancelled.", "RELOAD_ALREADY_STARTED");
    }
    const cancelled = await dependencies.cancelCycle({ cycleId, reason, actor });
    await dependencies.writeAudit({
      actorOperatorId: actor.id,
      source: "control",
      action: "delivery.reload.cancel",
      orderId,
      details: { cycleId, reason }
    });
    return cancelled;
  });
}
