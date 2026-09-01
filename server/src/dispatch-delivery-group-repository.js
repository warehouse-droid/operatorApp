import { query, withTransaction } from "./db.js";
import { dispatchLoadAssignment } from "./dispatch-load-assignment.js";
import {
  compactDispatchOrderCard,
  dispatchOrderSearchText
} from "./dispatch-planner-optimization.js";
import {
  applyActiveTransitCoMetadata,
  clearCancelledTransitCoMetadata
} from "./dispatch-planner-performance.js";

const GLOBAL_GROUP_ORDER_TYPES = new Set(["SO", "PO", "TO", "CO"]);
const GLOBAL_DERIVED_ORDER_TYPES = new Set(["SO", "PO", "TO", "CO", "CUSTOM"]);

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function text(value) {
  return String(value ?? "").trim();
}

function canonicalGroupedOrderType(order = {}) {
  const direct = text(order.type).toUpperCase();
  if (GLOBAL_GROUP_ORDER_TYPES.has(direct)) return direct;
  const childTypes = [...new Set((Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [])
    .map((child) => text(child?.type).toUpperCase())
    .filter((type) => GLOBAL_GROUP_ORDER_TYPES.has(type)))];
  return childTypes.length === 1 ? childTypes[0] : "";
}

function isAggregateCoGroup(order = {}) {
  if (canonicalGroupedOrderType(order) !== "CO") return false;
  const childRefs = Array.isArray(order.childOrders) ? order.childOrders : [];
  const childDetails = Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [];
  return childRefs.some((ref) => text(ref).toUpperCase().startsWith("CO-"))
    || childDetails.some((child) => (
      canonicalGroupedOrderType(child) === "CO"
      || text(child?.id).toUpperCase().startsWith("CO-")
    ));
}

function isGroupedDispatchOrder(order = {}) {
  const type = canonicalGroupedOrderType(order);
  return Boolean(type)
    && Array.isArray(order.childOrders)
    && order.childOrders.length > 0
    // A normal CO created for a grouped source carries the source children for
    // detail, but it is still one canonical local CO—not a grouped-CO order.
    && (type !== "CO" || isAggregateCoGroup(order));
}

function childOrderRefs(order = {}) {
  const refs = new Set();
  const visiting = new Set();
  const rootType = canonicalGroupedOrderType(order);

  const visit = (candidate, { root = false } = {}) => {
    const candidateId = String(candidate?.id || "").trim();
    const children = (Array.isArray(candidate?.childOrders) ? candidate.childOrders : [])
      .map((ref) => String(ref || "").trim())
      .filter(Boolean);
    if (!root && rootType === "CO" && canonicalGroupedOrderType(candidate) === "CO" && !isAggregateCoGroup(candidate)) {
      if (candidateId) refs.add(candidateId);
      return;
    }
    if (!children.length) {
      if (candidateId) refs.add(candidateId);
      return;
    }
    if (candidateId && visiting.has(candidateId)) return;
    if (candidateId) visiting.add(candidateId);

    const detailById = new Map(
      (Array.isArray(candidate?.childOrderDetails) ? candidate.childOrderDetails : [])
        .filter((detail) => detail?.id)
        .map((detail) => [String(detail.id), detail])
    );
    for (const childRef of children) {
      const detail = detailById.get(childRef);
      if (detail && Array.isArray(detail.childOrders) && detail.childOrders.length) visit(detail);
      else refs.add(childRef);
    }
    if (candidateId) visiting.delete(candidateId);
  };

  visit(order, { root: true });
  return [...refs].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

function childOrderMembers(order = {}, groupType = canonicalGroupedOrderType(order)) {
  const detailTypes = new Map();
  const visit = (candidate = {}) => {
    const candidateRef = text(candidate.id).toLowerCase();
    const candidateType = text(candidate.type).toUpperCase();
    if (candidateRef && GLOBAL_GROUP_ORDER_TYPES.has(candidateType)) {
      detailTypes.set(candidateRef, candidateType);
    }
    for (const child of Array.isArray(candidate.childOrderDetails) ? candidate.childOrderDetails : []) visit(child);
  };
  visit(order);
  return childOrderRefs(order).map((memberOrderRef) => {
    const memberType = detailTypes.get(memberOrderRef.toLowerCase())
      || (memberOrderRef.toUpperCase().startsWith("CO-") ? "CO" : "");
    return {
      memberOrderRef,
      // A CO created for a source group carries the source members for detail,
      // but it must not hide those SO/TO members from their own lifecycle.
      hidesMember: groupType === "CO"
        ? memberType === "CO"
        : !memberType || memberType === groupType
    };
  });
}

function findGroupAssignment(plan, groupRef) {
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      if (!(load.stops || []).some((stop) => String(stop.orderId || "") === groupRef)) continue;
      const assignment = dispatchLoadAssignment(truck, load);
      return {
        truckPlate: assignment.truckPlate,
        loadName: String(load.name || ""),
        parkingSpot: assignment.parkingSpot
      };
    }
  }
  return null;
}

function globalGroupSnapshot(order = {}, { sourcePlanId, sourcePlanDate, orderType } = {}) {
  const snapshot = JSON.parse(JSON.stringify(order));
  for (const field of [
    "dispatchSnapshotSourcePlanId",
    "dispatchSnapshotSourcePlanDate",
    "dispatchPlanned",
    "dispatchPlanId",
    "dispatchPlanDate",
    "dispatchTruckPlate",
    "dispatchLoadName",
    "dispatchParkingSpot",
    "dispatchDriverLogin",
    "dispatchDriverName",
    "jump",
    "readOnly",
    "assigned"
  ]) delete snapshot[field];
  return {
    ...snapshot,
    type: orderType || canonicalGroupedOrderType(order) || snapshot.type,
    globalGroupDefinition: true,
    globalGroupSourcePlanId: sourcePlanId === null || sourcePlanId === undefined ? "" : String(sourcePlanId),
    globalGroupSourcePlanDate: sourcePlanDate,
    groupPlanId: "",
    groupPlanDate: "",
    planOwned: false,
    dispatchPlanned: false,
    catalogHydrated: true
  };
}

function projectGlobalGroups(plan = {}) {
  const planId = Number(plan.id);
  const planDate = dateOnly(plan.planDate || plan.plan_date);
  if (!Number.isInteger(planId) || !planDate) return [];
  const groups = [];
  for (const order of plan.orders || []) {
    if (!isGroupedDispatchOrder(order)) continue;
    const orderType = canonicalGroupedOrderType(order);
    const groupRef = text(order.id);
    const members = childOrderMembers(order, orderType);
    const memberRefs = members.map((member) => member.memberOrderRef);
    if (!groupRef || !members.length) continue;
    const assignment = findGroupAssignment(plan, groupRef);
    const declaredSourcePlanId = Number(
      order.globalGroupSourcePlanId
      || order.groupPlanId
      || planId
    );
    const declaredSourcePlanDate = dateOnly(
      order.globalGroupSourcePlanDate
      || order.groupPlanDate
      || planDate
    );
    const belongsToPlan = declaredSourcePlanId === planId
      && (!declaredSourcePlanDate || declaredSourcePlanDate === planDate);
    // A foreign unassigned snapshot is stale plan-local structure, not a new
    // global definition. An actual assignment transfers canonical ownership.
    if (!belongsToPlan && !assignment) continue;
    const snapshot = globalGroupSnapshot(order, {
      sourcePlanId: planId,
      sourcePlanDate: planDate,
      orderType
    });
    groups.push({
      groupRef,
      orderType,
      sourcePlanId: planId,
      sourcePlanDate: planDate,
      sourceRevision: Math.max(0, Number(plan.revision || 0)),
      memberRefs,
      members,
      snapshot,
      card: compactDispatchOrderCard(snapshot),
      searchText: dispatchOrderSearchText(snapshot),
      eligible: order.eligible !== false,
      assigned: Boolean(assignment)
    });
  }
  return groups;
}

async function syncDispatchGlobalOrderGroupsFromPlan(plan = {}) {
  const planId = Number(plan.id);
  const planDate = dateOnly(plan.planDate || plan.plan_date);
  if (!Number.isInteger(planId) || !planDate) return { groups: 0, members: 0, deactivated: 0 };
  const projected = projectGlobalGroups(plan);
  const lockRefs = [...new Set(projected
    .map((group) => group.groupRef.toLowerCase())
    .filter(Boolean))].sort();
  for (const groupRef of lockRefs) {
    await query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`dispatch-global-order-group:${groupRef}`]
    );
  }
  const existingSources = projected.length
    ? await query(
        `SELECT lower(group_ref) AS group_key, source_plan_id,
                source_plan_date::text AS source_plan_date
           FROM dispatch_global_order_groups
          WHERE lower(group_ref) = ANY($1::text[])`,
        [projected.map((group) => group.groupRef.toLowerCase())]
      )
    : { rows: [] };
  const sourceByGroup = new Map(existingSources.rows.map((row) => [
    text(row.group_key),
    {
      planId: row.source_plan_id === null ? null : Number(row.source_plan_id),
      planDate: dateOnly(row.source_plan_date)
    }
  ]));
  const groups = projected.flatMap((group) => {
    const existingSource = sourceByGroup.get(group.groupRef.toLowerCase());
    if (existingSource && existingSource.planId !== planId && !group.assigned) return [];
    if (!existingSource) return [group];
    const sourcePlanId = existingSource.planId;
    const sourcePlanDate = existingSource.planDate || group.sourcePlanDate;
    const snapshot = {
      ...group.snapshot,
      globalGroupSourcePlanId: sourcePlanId === null ? "" : String(sourcePlanId),
      globalGroupSourcePlanDate: sourcePlanDate
    };
    return [{
      ...group,
      sourcePlanId,
      sourcePlanDate,
      snapshot,
      card: compactDispatchOrderCard(snapshot),
      searchText: dispatchOrderSearchText(snapshot)
    }];
  });
  const groupRefs = groups.map((group) => group.groupRef);
  // Missing from a compact plan means unassigned, not deleted. Retirement is
  // an explicit ungroup/unsplit operation handled by
  // deactivateDispatchGlobalOrderDefinitions().
  const deactivated = { rowCount: 0, rows: [] };
  if (groups.length) {
    await query(
      `INSERT INTO dispatch_global_order_groups (
         group_ref, order_type, source_plan_id, source_plan_date,
         full_order, card, search_text, eligible, active,
         source_revision, updated_at
       )
       SELECT source.group_ref, source.order_type, source.source_plan_id,
              source.source_plan_date, source.full_order, source.card,
              source.search_text, source.eligible, true,
              source.source_revision, now()
         FROM jsonb_to_recordset($1::jsonb) AS source(
           group_ref text, order_type text, source_plan_id bigint,
           source_plan_date date, full_order jsonb, card jsonb,
           search_text text, eligible boolean, source_revision bigint
         )
       ON CONFLICT (group_ref) DO UPDATE
         SET order_type = EXCLUDED.order_type,
             full_order = EXCLUDED.full_order,
             card = EXCLUDED.card,
             search_text = EXCLUDED.search_text,
             eligible = EXCLUDED.eligible,
             active = true,
             source_revision = EXCLUDED.source_revision,
             updated_at = now()`,
      [JSON.stringify(groups.map((group) => ({
        group_ref: group.groupRef,
        order_type: group.orderType,
        source_plan_id: group.sourcePlanId,
        source_plan_date: group.sourcePlanDate,
        full_order: group.snapshot,
        card: group.card,
        search_text: group.searchText,
        eligible: group.eligible,
        source_revision: group.sourceRevision
      })))]
    );
    await query(
      "DELETE FROM dispatch_global_order_group_members WHERE group_ref = ANY($1::text[])",
      [groupRefs]
    );
    const members = groups.flatMap((group) => group.members.map((member, position) => ({
      groupRef: group.groupRef,
      memberOrderRef: member.memberOrderRef,
      position,
      hidesMember: member.hidesMember
    })));
    await query(
      `INSERT INTO dispatch_global_order_group_members (
         group_ref, member_order_ref, position, hides_member
       )
       SELECT source.group_ref, source.member_order_ref, source.position,
              source.hides_member
         FROM jsonb_to_recordset($1::jsonb) AS source(
           group_ref text, member_order_ref text, position integer,
           hides_member boolean
         )`,
      [JSON.stringify(members.map((member) => ({
        group_ref: member.groupRef,
        member_order_ref: member.memberOrderRef,
        position: member.position,
        hides_member: member.hidesMember
      })))]
    );
  }
  if (groups.length || deactivated.rowCount) {
    await query(
      `UPDATE dispatch_order_catalog_state
          SET generation = generation + 1,
              updated_at = now()
        WHERE singleton = true`
    );
  }
  return {
    groups: groups.length,
    members: groups.reduce((count, group) => count + group.memberRefs.length, 0),
    deactivated: deactivated.rowCount
  };
}

function splitParentRef(order = {}) {
  const explicit = text(order.originalOrderId || order.parentOrderRef);
  if (explicit) return explicit;
  const ref = text(order.id);
  return /-S\d+$/iu.test(ref) ? ref.replace(/-S\d+$/iu, "") : "";
}

function canonicalDerivedOrderType(order = {}) {
  const type = text(order.type).toUpperCase();
  return GLOBAL_DERIVED_ORDER_TYPES.has(type) ? type : "";
}

function derivedDefinitionKind(order = {}) {
  if (!canonicalDerivedOrderType(order)) return "";
  if (splitParentRef(order)) return "split";
  const declared = text(order.globalOrderDefinitionKind).toLowerCase();
  if (["consolidation", "derived"].includes(declared)) return declared;
  if (text(order.id).toUpperCase().startsWith("TO-DRAFT-")) return "consolidation";
  return "";
}

function derivedParentRef(order = {}, plan = {}) {
  const explicit = splitParentRef(order) || text(order.sourceOrderId || order.parentOrderRef);
  if (explicit) return explicit;
  const ref = text(order.id).toLowerCase();
  const source = (plan.orders || []).find((candidate) => (
    text(candidate?.consolidation?.transferOrderId).toLowerCase() === ref
  ));
  return text(source?.id);
}

function isGlobalDerivedOrder(order = {}) {
  return Boolean(derivedDefinitionKind(order));
}

function globalSplitSnapshot(order = {}, {
  sourcePlanId,
  sourcePlanDate,
  orderType,
  definitionKind,
  parentOrderRef
} = {}) {
  const snapshot = JSON.parse(JSON.stringify(order));
  for (const field of [
    "dispatchSnapshotSourcePlanId",
    "dispatchSnapshotSourcePlanDate",
    "dispatchPlanned",
    "dispatchPlanId",
    "dispatchPlanDate",
    "dispatchTruckPlate",
    "dispatchLoadName",
    "dispatchParkingSpot",
    "dispatchDriverLogin",
    "dispatchDriverName",
    "jump",
    "readOnly",
    "assigned"
  ]) delete snapshot[field];
  return {
    ...snapshot,
    type: orderType || canonicalDerivedOrderType(order) || snapshot.type,
    ...(definitionKind === "split" ? { originalOrderId: parentOrderRef } : {}),
    ...(definitionKind !== "split" && parentOrderRef && !snapshot.sourceOrderId
      ? { sourceOrderId: parentOrderRef }
      : {}),
    globalOrderDefinition: true,
    globalOrderDefinitionKind: definitionKind,
    globalOrderSourcePlanId: sourcePlanId === null || sourcePlanId === undefined ? "" : String(sourcePlanId),
    globalOrderSourcePlanDate: sourcePlanDate,
    planOwned: false,
    dispatchPlanned: false,
    catalogHydrated: true
  };
}

function projectGlobalSplits(plan = {}) {
  const planId = Number(plan.id);
  const sourcePlanDate = dateOnly(plan.planDate || plan.plan_date);
  if (!Number.isInteger(planId) || !sourcePlanDate) return [];
  const splits = [];
  for (const order of plan.orders || []) {
    if (!isGlobalDerivedOrder(order)) continue;
    const splitRef = text(order.id);
    const definitionKind = derivedDefinitionKind(order);
    const parentOrderRef = derivedParentRef(order, plan);
    if (definitionKind === "split" && !parentOrderRef) continue;
    const assignment = findGroupAssignment(plan, splitRef);
    const declaredSourcePlanId = Number(
      order.globalOrderSourcePlanId
      || order.dispatchSnapshotSourcePlanId
      || planId
    );
    const declaredSourcePlanDate = dateOnly(
      order.globalOrderSourcePlanDate
      || order.dispatchSnapshotSourcePlanDate
      || sourcePlanDate
    );
    const belongsToPlan = declaredSourcePlanId === planId
      && (!declaredSourcePlanDate || declaredSourcePlanDate === sourcePlanDate);
    if (!belongsToPlan && !assignment) continue;
    const orderType = canonicalDerivedOrderType(order);
    const snapshot = globalSplitSnapshot(order, {
      sourcePlanId: planId,
      sourcePlanDate,
      orderType,
      definitionKind,
      parentOrderRef
    });
    splits.push({
      splitRef,
      orderType,
      definitionKind,
      parentOrderRef,
      sourcePlanId: planId,
      sourcePlanDate,
      sourceRevision: Math.max(0, Number(plan.revision || 0)),
      snapshot,
      card: compactDispatchOrderCard(snapshot),
      searchText: dispatchOrderSearchText(snapshot),
      eligible: order.eligible !== false,
      assigned: Boolean(assignment)
    });
  }
  return splits;
}

async function syncDispatchGlobalOrderSplitsFromPlan(plan = {}) {
  const planId = Number(plan.id);
  const sourcePlanDate = dateOnly(plan.planDate || plan.plan_date);
  if (!Number.isInteger(planId) || !sourcePlanDate) return { splits: 0, deactivated: 0 };
  const projected = projectGlobalSplits(plan);
  const lockRefs = [...new Set(projected
    .map((split) => split.splitRef.toLowerCase())
    .filter(Boolean))].sort();
  for (const splitRef of lockRefs) {
    await query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`dispatch-global-order-split:${splitRef}`]
    );
  }
  const existingSources = projected.length
    ? await query(
        `SELECT lower(split_ref) AS split_key, source_plan_id,
                source_plan_date::text AS source_plan_date
           FROM dispatch_global_order_splits
          WHERE lower(split_ref) = ANY($1::text[])`,
        [projected.map((split) => split.splitRef.toLowerCase())]
      )
    : { rows: [] };
  const sourceBySplit = new Map(existingSources.rows.map((row) => [
    text(row.split_key),
    {
      planId: row.source_plan_id === null ? null : Number(row.source_plan_id),
      planDate: dateOnly(row.source_plan_date)
    }
  ]));
  const splits = projected.flatMap((split) => {
    const existingSource = sourceBySplit.get(split.splitRef.toLowerCase());
    if (existingSource && existingSource.planId !== planId && !split.assigned) return [];
    if (!existingSource) return [split];
    const sourcePlanId = existingSource.planId;
    const sourcePlanDate = existingSource.planDate || split.sourcePlanDate;
    const snapshot = {
      ...split.snapshot,
      globalOrderSourcePlanId: sourcePlanId === null ? "" : String(sourcePlanId),
      globalOrderSourcePlanDate: sourcePlanDate
    };
    return [{
      ...split,
      sourcePlanId,
      sourcePlanDate,
      snapshot,
      card: compactDispatchOrderCard(snapshot),
      searchText: dispatchOrderSearchText(snapshot)
    }];
  });
  const splitRefs = splits.map((split) => split.splitRef);
  const deactivated = { rowCount: 0, rows: [] };
  if (splits.length) {
    await query(
      `INSERT INTO dispatch_global_order_splits (
         split_ref, order_type, definition_kind, parent_order_ref, source_plan_id,
         source_plan_date, full_order, card, search_text, eligible, active,
         source_revision, updated_at
       )
       SELECT source.split_ref, source.order_type, source.definition_kind,
              source.parent_order_ref,
              source.source_plan_id, source.source_plan_date, source.full_order,
              source.card, source.search_text, source.eligible, true,
              source.source_revision, now()
         FROM jsonb_to_recordset($1::jsonb) AS source(
           split_ref text, order_type text, definition_kind text,
           parent_order_ref text,
           source_plan_id bigint, source_plan_date date, full_order jsonb,
           card jsonb, search_text text, eligible boolean,
           source_revision bigint
         )
       ON CONFLICT (split_ref) DO UPDATE
         SET order_type = EXCLUDED.order_type,
             definition_kind = EXCLUDED.definition_kind,
             parent_order_ref = EXCLUDED.parent_order_ref,
             full_order = EXCLUDED.full_order,
             card = EXCLUDED.card,
             search_text = EXCLUDED.search_text,
             eligible = EXCLUDED.eligible,
             active = true,
             source_revision = EXCLUDED.source_revision,
             updated_at = now()`,
      [JSON.stringify(splits.map((split) => ({
        split_ref: split.splitRef,
        order_type: split.orderType,
        definition_kind: split.definitionKind,
        parent_order_ref: split.parentOrderRef,
        source_plan_id: split.sourcePlanId,
        source_plan_date: split.sourcePlanDate,
        full_order: split.snapshot,
        card: split.card,
        search_text: split.searchText,
        eligible: split.eligible,
        source_revision: split.sourceRevision
      })))]
    );
  }
  if (splits.length || deactivated.rowCount) {
    await query(
      `UPDATE dispatch_order_catalog_state
          SET generation = generation + 1,
              updated_at = now()
        WHERE singleton = true`
    );
  }
  return { splits: splits.length, deactivated: deactivated.rowCount };
}

function transitCoRecord(co = {}, sourceOrderRef = "") {
  return {
    coRef: text(co.co_ref || co.coRef || co.id),
    sourceOrderRef: text(co.source_order_ref || co.sourceOrderRef || sourceOrderRef),
    fromYard: text(co.from_location || co.fromYard),
    toYard: text(co.to_location || co.toYard),
    status: text(co.status),
    createdAt: co.created_at || co.createdAt || null
  };
}

async function updateGlobalDefinitionTransitCo({
  tableName,
  refColumn,
  sourceOrderRef,
  co,
  cancelled
}) {
  const sourceRef = text(sourceOrderRef || co?.source_order_ref || co?.sourceOrderRef);
  const record = transitCoRecord(co, sourceRef);
  if (!sourceRef || !record.coRef) return [];
  const rows = await query(
    `SELECT ${refColumn} AS order_ref, full_order
       FROM ${tableName}
      WHERE active = true
        AND (
          lower(${refColumn}) = lower($1)
          OR full_order::text ILIKE ('%' || $1 || '%')
        )`,
    [sourceRef]
  );
  const updatedRefs = [];
  for (const row of rows.rows) {
    const current = row.full_order || {};
    let next = cancelled
      ? clearCancelledTransitCoMetadata(current, [record])
      : applyActiveTransitCoMetadata(current, [record]);
    if (
      tableName === "dispatch_global_order_groups"
      && Array.isArray(next.childOrderDetails)
      && next.childOrderDetails.length
    ) {
      next = aggregateGlobalGroup(next, next.childOrderDetails, { preserveTransitCo: true });
    }
    if (JSON.stringify(next) === JSON.stringify(current)) continue;
    await query(
      `UPDATE ${tableName}
          SET full_order = $2::jsonb,
              card = $3::jsonb,
              search_text = $4,
              updated_at = now()
        WHERE lower(${refColumn}) = lower($1)`,
      [
        row.order_ref,
        JSON.stringify(next),
        JSON.stringify(compactDispatchOrderCard(next)),
        dispatchOrderSearchText(next)
      ]
    );
    updatedRefs.push(text(row.order_ref));
  }
  return updatedRefs;
}

export async function syncDispatchGlobalOrderTransitCo({
  sourceOrderRef = "",
  co = {},
  cancelled = false
} = {}) {
  const groups = await updateGlobalDefinitionTransitCo({
    tableName: "dispatch_global_order_groups",
    refColumn: "group_ref",
    sourceOrderRef,
    co,
    cancelled
  });
  const splits = await updateGlobalDefinitionTransitCo({
    tableName: "dispatch_global_order_splits",
    refColumn: "split_ref",
    sourceOrderRef,
    co,
    cancelled
  });
  const orderRefs = [...new Set([...groups, ...splits])];
  if (orderRefs.length) {
    await query(
      `UPDATE dispatch_order_catalog_state
          SET generation = generation + 1,
              updated_at = now()
        WHERE singleton = true`
    );
  }
  return { updated: orderRefs.length, orderRefs };
}

async function reconcileGlobalDefinitionTableTransitCos({
  tableName,
  refColumn,
  activeBySource,
  cancelledByRef
}) {
  const rows = await query(
    `SELECT ${refColumn} AS order_ref, full_order
       FROM ${tableName}
      WHERE active = true
      ORDER BY lower(${refColumn})`
  );
  const updatedRefs = [];
  for (const row of rows.rows) {
    const current = row.full_order || {};
    let next = clearCancelledTransitCoMetadata(current, cancelledByRef);
    next = applyActiveTransitCoMetadata(next, activeBySource);
    if (
      tableName === "dispatch_global_order_groups"
      && Array.isArray(next.childOrderDetails)
      && next.childOrderDetails.length
    ) {
      next = aggregateGlobalGroup(next, next.childOrderDetails, { preserveTransitCo: true });
    }
    if (JSON.stringify(next) === JSON.stringify(current)) continue;
    await query(
      `UPDATE ${tableName}
          SET full_order = $2::jsonb,
              card = $3::jsonb,
              search_text = $4,
              updated_at = now()
        WHERE lower(${refColumn}) = lower($1)`,
      [
        row.order_ref,
        JSON.stringify(next),
        JSON.stringify(compactDispatchOrderCard(next)),
        dispatchOrderSearchText(next)
      ]
    );
    updatedRefs.push(text(row.order_ref));
  }
  return updatedRefs;
}

export async function reconcileDispatchGlobalOrderTransitCos() {
  return withTransaction(async () => {
    const localCos = await query(
      `SELECT co_ref, source_order_ref, from_location, to_location,
              status, created_at, updated_at
         FROM local_co_orders
        ORDER BY updated_at, id`
    );
    const activeBySource = new Map();
    const cancelledByRef = new Map();
    for (const row of localCos.rows) {
      const record = transitCoRecord(row, row.source_order_ref);
      if (text(row.status).toLowerCase() === "cancelled") {
        cancelledByRef.set(record.coRef.toLowerCase(), record);
      } else if (record.sourceOrderRef && record.coRef && record.fromYard && record.toYard) {
        activeBySource.set(record.sourceOrderRef.toLowerCase(), record);
      }
    }
    const groups = await reconcileGlobalDefinitionTableTransitCos({
      tableName: "dispatch_global_order_groups",
      refColumn: "group_ref",
      activeBySource,
      cancelledByRef
    });
    const splits = await reconcileGlobalDefinitionTableTransitCos({
      tableName: "dispatch_global_order_splits",
      refColumn: "split_ref",
      activeBySource,
      cancelledByRef
    });
    const orderRefs = [...new Set([...groups, ...splits])];
    if (orderRefs.length) {
      await query(
        `UPDATE dispatch_order_catalog_state
            SET generation = generation + 1,
                updated_at = now()
          WHERE singleton = true`
      );
    }
    return { updated: orderRefs.length, orderRefs };
  });
}

function aggregateGlobalGroup(order = {}, childOrderDetails = [], { preserveTransitCo = false } = {}) {
  const sum = (field) => childOrderDetails.reduce(
    (total, child) => total + Number(child?.[field] || 0),
    0
  );
  const pickupLocations = [...new Set(childOrderDetails
    .flatMap((child) => child.pickupLocations || [])
    .map(text)
    .filter(Boolean))];
  return {
    ...order,
    childOrders: childOrderDetails.map((child) => text(child?.id)).filter(Boolean),
    childOrderDetails,
    items: childOrderDetails.flatMap((child) => Array.isArray(child.items) ? child.items : []),
    pallets: sum("pallets"),
    layers: sum("layers"),
    sections: sum("sections"),
    pieces: sum("pieces"),
    salesQty: sum("salesQty"),
    weight: sum("weight"),
    unloadMinutes: sum("unloadMinutes"),
    travelMinutes: Math.max(0, ...childOrderDetails.map((child) => Number(child?.travelMinutes || 0))),
    pickupLocations,
    sourceYard: pickupLocations.length === 1 ? pickupLocations[0] : order.sourceYard,
    customer: `${childOrderDetails.length} orders grouped`,
    sourceOrderId: "",
    relatedSoId: "",
    relatedToId: "",
    relatedCustomOrderId: "",
    transitCo: preserveTransitCo ? order.transitCo : null
  };
}

export async function removeDispatchGlobalGroupedMember(memberOrderRef = "") {
  const target = text(memberOrderRef);
  if (!target) return { updated: [], deactivated: [] };
  return withTransaction(async () => {
    const candidates = await query(
      `SELECT global_group.group_ref, global_group.full_order
         FROM dispatch_global_order_groups global_group
         JOIN dispatch_global_order_group_members member
           ON member.group_ref = global_group.group_ref
        WHERE global_group.active = true
          AND member.hides_member = true
          AND lower(member.member_order_ref) = lower($1)
        ORDER BY lower(global_group.group_ref)
        FOR UPDATE OF global_group`,
      [target]
    );
    const updated = [];
    const deactivated = [];
    for (const row of candidates.rows) {
      const current = row.full_order || {};
      const listed = (Array.isArray(current.childOrders) ? current.childOrders : [])
        .map(text)
        .filter((ref) => ref && ref.toLowerCase() !== target.toLowerCase());
      const detailByRef = new Map((Array.isArray(current.childOrderDetails) ? current.childOrderDetails : [])
        .map((child) => [text(child?.id).toLowerCase(), child])
        .filter(([ref]) => ref));
      const retainedDetails = listed.map((ref) => detailByRef.get(ref.toLowerCase())).filter(Boolean);
      if (!listed.length) {
        await query(
          `UPDATE dispatch_global_order_groups
              SET active = false, updated_at = now()
            WHERE group_ref = $1`,
          [row.group_ref]
        );
        deactivated.push(text(row.group_ref));
        continue;
      }
      const next = retainedDetails.length === listed.length
        ? aggregateGlobalGroup(current, retainedDetails)
        : {
            ...current,
            childOrders: listed,
            childOrderDetails: retainedDetails,
            groupAliases: (Array.isArray(current.groupAliases) ? current.groupAliases : [])
              .filter((ref) => text(ref).toLowerCase() !== target.toLowerCase())
          };
      await query(
        `UPDATE dispatch_global_order_groups
            SET full_order = $2::jsonb,
                card = $3::jsonb,
                search_text = $4,
                updated_at = now()
          WHERE group_ref = $1`,
        [
          row.group_ref,
          JSON.stringify(next),
          JSON.stringify(compactDispatchOrderCard(next)),
          dispatchOrderSearchText(next)
        ]
      );
      await query(
        "DELETE FROM dispatch_global_order_group_members WHERE group_ref = $1",
        [row.group_ref]
      );
      const members = childOrderMembers(next, canonicalGroupedOrderType(next));
      if (members.length) {
        await query(
          `INSERT INTO dispatch_global_order_group_members (
             group_ref, member_order_ref, position, hides_member
           )
           SELECT $1, source.member_order_ref, source.position, source.hides_member
             FROM jsonb_to_recordset($2::jsonb) AS source(
               member_order_ref text, position integer, hides_member boolean
             )`,
          [row.group_ref, JSON.stringify(members.map((member, position) => ({
            member_order_ref: member.memberOrderRef,
            position,
            hides_member: member.hidesMember
          })))]
        );
      }
      updated.push(text(row.group_ref));
    }
    if (updated.length || deactivated.length) {
      await query(
        `UPDATE dispatch_order_catalog_state
            SET generation = generation + 1,
                updated_at = now()
          WHERE singleton = true`
      );
    }
    return { updated, deactivated };
  });
}

export async function deactivateDispatchGlobalOrderDefinitions(orderRefs = []) {
  const refs = [...new Set((Array.isArray(orderRefs) ? orderRefs : [])
    .map((ref) => text(ref).toLowerCase())
    .filter(Boolean))];
  if (!refs.length) return { groups: [], splits: [] };
  const groups = await query(
    `UPDATE dispatch_global_order_groups
        SET active = false,
            updated_at = now()
      WHERE active = true
        AND lower(group_ref) = ANY($1::text[])
      RETURNING group_ref`,
    [refs]
  );
  const splits = await query(
    `UPDATE dispatch_global_order_splits
        SET active = false,
            updated_at = now()
      WHERE active = true
        AND lower(split_ref) = ANY($1::text[])
      RETURNING split_ref`,
    [refs]
  );
  if (groups.rowCount || splits.rowCount) {
    await query(
      `UPDATE dispatch_order_catalog_state
          SET generation = generation + 1,
              updated_at = now()
        WHERE singleton = true`
    );
  }
  return {
    groups: groups.rows.map((row) => text(row.group_ref)),
    splits: splits.rows.map((row) => text(row.split_ref))
  };
}

function projectGroups(plan = {}) {
  const planDate = dateOnly(plan.planDate || plan.plan_date);
  if (!plan.id || !planDate || text(plan.status).toLowerCase() === "cancelled") return [];
  const groups = [];
  for (const order of plan.orders || []) {
    if (!isGroupedDispatchOrder(order)) continue;
    const orderType = canonicalGroupedOrderType(order);
    if (!["SO", "TO"].includes(orderType)) continue;
    const groupRef = String(order.id || "").trim();
    if (!groupRef) continue;
    const memberRefs = childOrderRefs(order);
    const assignment = findGroupAssignment(plan, groupRef);
    if (!memberRefs.length || !assignment) continue;
    groups.push({
      groupRef,
      planId: Number(plan.id),
      planDate,
      orderType: orderType === "TO" ? "transfer_order" : "sales_order",
      memberRefs,
      ...assignment
    });
  }
  return groups;
}

export async function syncDispatchDeliveryGroupsFromPlan(plan = {}) {
  const planId = Number(plan.id);
  if (!Number.isInteger(planId)) return { groups: 0, members: 0 };
  const globalGroups = await syncDispatchGlobalOrderGroupsFromPlan(plan);
  const globalSplits = await syncDispatchGlobalOrderSplitsFromPlan(plan);
  const groups = projectGroups(plan);

  await query(
    `UPDATE dispatch_delivery_groups
        SET active = false,
            updated_at = now()
      WHERE plan_id = $1`,
    [planId]
  );
  if (!groups.length) return { groups: 0, members: 0, globalGroups, globalSplits };

  await query(
    `INSERT INTO dispatch_delivery_groups (
       group_ref, plan_id, plan_date, order_type, truck_plate, load_name,
       parking_spot, active, updated_at
     )
     SELECT value->>'groupRef',
            (value->>'planId')::bigint,
            (value->>'planDate')::date,
            value->>'orderType',
            COALESCE(value->>'truckPlate', ''),
            COALESCE(value->>'loadName', ''),
            COALESCE(value->>'parkingSpot', ''),
            true,
            now()
       FROM jsonb_array_elements($1::jsonb) AS projected(value)
     ON CONFLICT (group_ref) DO UPDATE
       SET plan_id = EXCLUDED.plan_id,
           plan_date = EXCLUDED.plan_date,
           order_type = EXCLUDED.order_type,
           truck_plate = EXCLUDED.truck_plate,
           load_name = EXCLUDED.load_name,
           parking_spot = EXCLUDED.parking_spot,
           active = true,
           updated_at = now()`,
    [JSON.stringify(groups)]
  );

  const groupRefs = groups.map((group) => group.groupRef);
  await query("DELETE FROM dispatch_delivery_group_members WHERE group_ref = ANY($1::text[])", [groupRefs]);
  const members = groups.flatMap((group) => group.memberRefs.map((memberOrderRef, position) => ({
    groupRef: group.groupRef,
    memberOrderRef,
    position
  })));
  await query(
    `INSERT INTO dispatch_delivery_group_members (group_ref, member_order_ref, position)
     SELECT value->>'groupRef', value->>'memberOrderRef', (value->>'position')::integer
       FROM jsonb_array_elements($1::jsonb) AS projected(value)
     ON CONFLICT (group_ref, member_order_ref) DO UPDATE
       SET position = EXCLUDED.position`,
    [JSON.stringify(members)]
  );
  return { groups: groups.length, members: members.length, globalGroups, globalSplits };
}

function mapGroup(row) {
  if (!row) return null;
  return {
    id: row.group_ref,
    type: row.order_type === "transfer_order" ? "TO" : "SO",
    orderType: row.order_type,
    childRefs: Array.isArray(row.child_refs) ? row.child_refs : [],
    planId: row.plan_id,
    planDate: dateOnly(row.plan_date),
    truckPlate: row.truck_plate || "",
    loadName: row.load_name || "",
    parkingSpot: row.parking_spot || ""
  };
}

export async function listDispatchDeliveryGroups({ orderType = "sales_order", includePast = false } = {}) {
  const result = await query(
    `SELECT g.*,
            COALESCE(jsonb_agg(m.member_order_ref ORDER BY m.position)
              FILTER (WHERE m.member_order_ref IS NOT NULL), '[]'::jsonb) AS child_refs
       FROM dispatch_delivery_groups g
       LEFT JOIN dispatch_delivery_group_members m ON m.group_ref = g.group_ref
      WHERE g.active = true
        AND g.order_type = $1
        ${includePast ? "" : "AND g.plan_date >= CURRENT_DATE"}
      GROUP BY g.group_ref
      ORDER BY g.plan_date DESC, g.updated_at DESC, g.group_ref`,
    [orderType]
  );
  return result.rows.map(mapGroup);
}

export async function getDispatchDeliveryGroup(groupRef) {
  const result = await query(
    `SELECT g.*,
            COALESCE(jsonb_agg(m.member_order_ref ORDER BY m.position)
              FILTER (WHERE m.member_order_ref IS NOT NULL), '[]'::jsonb) AS child_refs
       FROM dispatch_delivery_groups g
       LEFT JOIN dispatch_delivery_group_members m ON m.group_ref = g.group_ref
      WHERE g.group_ref = $1
        AND g.active = true
      GROUP BY g.group_ref
      LIMIT 1`,
    [String(groupRef || "").trim()]
  );
  return mapGroup(result.rows[0]);
}

export async function rebuildDispatchDeliveryGroups() {
  return withTransaction(async () => {
    await query("UPDATE dispatch_delivery_groups SET active = false, updated_at = now() WHERE active = true");
    const result = await query(
      `SELECT p.id, p.plan_date::text AS plan_date, p.status, p.revision,
              s.orders, s.trucks
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        ORDER BY p.updated_at, p.id`
    );
    let groupCount = 0;
    let memberCount = 0;
    for (const row of result.rows) {
      const synced = await syncDispatchDeliveryGroupsFromPlan({
        id: row.id,
        planDate: row.plan_date,
        status: row.status,
        revision: Number(row.revision || 0),
        orders: row.orders || [],
        trucks: row.trucks || []
      });
      groupCount += synced.groups;
      memberCount += synced.members;
    }
    return { plans: result.rowCount, groups: groupCount, members: memberCount };
  });
}
