import { normalizeSpecialExpiry } from '../public/special-stock-expiry.js';
import { parseVendorNames } from '../public/stock-request-vendor-filter.js';
import crypto from "node:crypto";
import { specialVendorLineDiscountReview, refreshSpecialVendorDiscountReview, specialPurchasePalletLine } from "../public/special-stock-purchase-pricing.js";
import {findSpecialCustomer,searchSpecialCustomerDirectory} from "./special-stock-customer-directory.js";
import { SPECIAL_STAGES, nextReminderDate, parseStages, torontoDate, specialStockAvailable } from "../public/special-stock-workflow.js";
import {canAddSpecialItems} from '../public/special-stock-request-actions.js';
import { canEditSpecialCaseLines, planSpecialCaseEdits, revokeSpecialLineDecision, specialCaseStageAfterEdits } from '../public/special-stock-case-edits.js';
import { canEditSpecialHeader, normalizeSpecialHeaderNote } from '../public/special-stock-fulfillment.js';
import { canEditSpecialSalesInternalRemark, normalizeSpecialSalesInternalRemark } from '../public/special-stock-internal-remark.js';

import { query, withTransaction, pool } from "./db.js";
import { parseYardIds } from '../public/stock-request-yard-filter.js';
import { assertSpecialDeliveryDate, normalizeSpecialDiscount, normalizeSpecialRate, specialPalletQuantity, specialDiscountLineSubtotal as specialLineSubtotal, specialNativePricing, specialNativeLinePricing, specialQuantity } from '../public/special-stock-pricing.js';
import { prepareSpecialMaterial, draftQuantityChanges, quantityReviewPending, assertNoSpecialQuantityReview } from './special-stock-pricing-domain.js';
import { reviewedQuantityTransitions } from './special-stock-quantity-reconciliation.js';
import { readSpecialDispatchPlans, specialDispatchPlanning } from './special-stock-planning.js';
import { isLocalPickupChange } from './special-stock-fulfillment-policy.js';
import { assertSpecialClosedOrderEvidence } from './special-stock-closed-orders.js';
import { createSalesOrderPoAllocations, updatePurchaseOrderDispatchRef } from "./dispatch-repository.js";
import {
  assertSpecialOrderRelease,
  assertSpecialPurchaseRelease,
  deriveSpecialCaseStage,
  matchSpecialOrderCoverage,
  normalizeSpecialCaseDraft,
  normalizeSpecialAdditionalLines,
  normalizeSpecialFulfillment,
  normalizeSpecialHandoffRoute,
  normalizeSpecialSalesDecision,
  normalizeSpecialSalesOrderDraft,
  normalizeSpecialSupplyResponse,
  normalizeSpecialVendorPickupCompletion
} from "./special-stock-request-domain.js";
import { projectSpecialStockCase, assertSpecialStockRemoteOrderAllowed, SPECIAL_STOCK_REQUEST_FLAG_KEY, SPECIAL_STOCK_TEST_SKIP_FLAG_KEY } from "./special-stock-request-policy.js";

const YARD_NAMES = new Map([[1, "3445"], [28, "2967"], [15, "12441"], [26, "150"]]);
const TERMINAL_DECISIONS = new Set(["accepted", "declined", "closed"]);

function newQuantityReview(lines, mode, operatorId) {
  return { id: crypto.randomUUID(), status: 'pending', mode, lines, requestedBy: operatorId,
    requestedAt: new Date().toISOString() };
}

function workflowError(message, status = 400, code = "SPECIAL_STOCK_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

/** @param {Record<string,any>} special */
function assertCaseEditable(special, { allowPendingUpdate = false } = {}) {
  if (!allowPendingUpdate && special.information_request?.status === 'pending') {
    throw workflowError('Sales must submit the requested information before stock checking or order actions.', 409, 'SPECIAL_UPDATE_PENDING');
  }
  if (['applying','attention'].includes(special.fulfillment_change?.status)
      || ['applying','attention'].includes(special.quantity_review?.status)
      || [special.sales_order_operation_status, special.purchase_order_operation_status].some(status => ['creating', 'attention'].includes(status))) {
    throw workflowError('Resolve the current NetSuite operation before changing this request.', 409, 'SPECIAL_OPERATION_BUSY');
  }
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw workflowError(`A valid ${label} ID is required.`);
  return id;
}

function expectedRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw workflowError("A positive expectedRevision is required.", 400, "SPECIAL_REVISION_REQUIRED");
  }
  return revision;
}

function optionalLimit(value, fallback = 60, maximum = 150) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(number)));
}

function cleanSearch(value, maximum = 120) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateValue(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function timeValue(value) {
  if (!value) return null;
  return String(value).slice(0, 5);
}

function terminalSalesOrder(row = {}) {
  const status = `${row.canonical_sales_status || row.sales_order_status || ""} ${row.canonical_sales_status_text || ""} ${row.canonical_sales_fulfillment_status || ""}`;
  return row.sales_order_netsuite_id
    && (/\b(?:closed|cancelled|canceled|fully fulfilled|fulfilled|fully billed)\b/i.test(status)
      || row.canonical_sales_fulfilled_at);
}

function terminalPurchaseOrder(row = {}) {
  const status = `${row.canonical_purchase_status || row.purchase_order_status || ""} ${row.canonical_purchase_status_text || ""} ${row.canonical_purchase_receipt_status || ""}`;
  return row.purchase_order_netsuite_id
    && (/\b(?:closed|cancelled|canceled|fully received|received|fully billed)\b/i.test(status)
      || row.canonical_purchase_received_at);
}

function mapLine(row = {}) {
  const originalRate = numberOrNull(row.original_unit_rate);
  const packageQuantity = numberOrNull(row.sales_package_quantity) ?? Number(row.requested_quantity);
  const quotedQuantity = row.pricing_source === 'enquiry' ? Number(row.requested_quantity) : packageQuantity;
  const itemResolution = row.resolved_item_id === null || row.resolved_item_id === undefined
    ? null
    : {
        itemId: Number(row.resolved_item_id),
        itemName: row.resolved_item_name || "",
        description: row.resolved_description || "",
        salesUom: row.sales_uom || "",
        purchaseUom: row.purchase_uom || "",
        salesQuantity: numberOrNull(row.sales_quantity),
        purchaseQuantity: numberOrNull(row.purchase_quantity),
        palletQuantity: numberOrNull(row.pallet_quantity)
      };
  return {
    id: Number(row.id),
    requestId: Number(row.request_id),
    lineNumber: Number(row.line_number),
    brand: row.brand || "",
    productName: row.product_name || "",
    detailSpec: row.detail_spec || "",
    palletQty: numberOrNull(row.pack_pallet_qty),
    layerQty: numberOrNull(row.pack_layer_qty),
    sectionQty: numberOrNull(row.pack_section_qty),
    pieceQty: numberOrNull(row.pack_piece_qty),
    color: row.color || "",
    size: row.size || "",
    quantity: Number(row.requested_quantity),
    uom: row.requested_uom || "",
    originalRate,
    rateUom: row.original_rate_uom || (row.pricing_source === 'legacy' ? row.sales_uom || 'PC' : row.requested_uom) || '',
    pricingSource: row.pricing_source || 'legacy',
    quotedDiscountPercent: Number(row.quoted_discount_percent || 0),
    discountPercent: Number(row.discount_percent || 0),
    packageQuantity,
    conversionToPc: numberOrNull(row.pieces_per_unit),
    reviewedPackageQuantity: numberOrNull(row.scm_reviewed_quantity),
    reviewedConversionToPc: numberOrNull(row.scm_reviewed_pieces_per_unit),
    subtotal: originalRate === null ? null : specialLineSubtotal(packageQuantity, originalRate, row.discount_percent || 0),
    quotedSubtotal: originalRate === null ? null : specialLineSubtotal(quotedQuantity, originalRate, row.quoted_discount_percent || 0),
    requiredDate: dateValue(row.required_date),
    estimateLineReference: row.estimate_line_reference || "",
    customerNote: row.customer_note || "",
    supplyStatus: row.supply_status || null,
    availabilityMode: row.availability_mode || null,
    availableDate: dateValue(row.available_date),
    reminderDueDate: dateValue(row.reminder_due_date),
    stockCheckedAt: row.stock_checked_at || null,
    responseVendorId: numberOrNull(row.response_vendor_id),
    responseVendorName: row.response_vendor_name || "",
    vendorYard: row.vendor_yard || "",
    vendorReference: row.vendor_reference || "",
    salesVisibleNote: row.sales_visible_note || "",
    scmInternalNote: row.scm_internal_note || "",
    unitPurchaseCost: numberOrNull(row.unit_purchase_cost),
    currency: row.purchase_currency || null,
    itemResolution,
    salesDecision: row.sales_decision || "pending",
    declineRestore: /** @type {Record<string,any>} */ (row).decline_restore || {},
    salesDecisionReason: row.sales_decision_reason || "",
    salesCustomerNote: row.sales_customer_note || "",
    responseRevision: Number(row.response_revision) || 0,
    decisionRevision: Number(row.decision_revision) || 0,
    poReady: row.po_ready === true,
    poReadyBy: row.po_ready_by || null,
    poReadyAt: row.po_ready_at || null,
    poReadyResponseRevision: numberOrNull(row.po_ready_response_revision),
    respondedBy: row.responded_by || null,
    respondedAt: row.responded_at || null,
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function mapOrderLine(row = {}) {
  return {
    id: Number(row.id),
    requestId: Number(row.request_id),
    caseLineId: numberOrNull(row.case_line_id),
    orderKind: row.order_kind,
    ancillary: row.ancillary === true,
    itemId: Number(row.item_id),
    itemName: row.item_name || "",
    description: row.description || "",
    palletQty: numberOrNull(row.pack_pallet_qty),
    layerQty: numberOrNull(row.pack_layer_qty),
    sectionQty: numberOrNull(row.pack_section_qty),
    pieceQty: numberOrNull(row.pack_piece_qty),
    quantity: Number(row.quantity),
    uom: row.uom || null,
    rate: numberOrNull(row.unit_rate),
    ...(row.native_discount_percent == null ? {} : { nativeDiscountPercent: Number(row.native_discount_percent) }),
    unitPurchaseCost: numberOrNull(row.unit_purchase_cost),
    remoteLineId: numberOrNull(row.remote_line_id)
  };
}

/** @param {Record<string,any>} row */
function mapCase(row = {}) {
  const { plan: quantityReviewPlan = null, ...quantityReview } = row.quantity_review || {};
  const { plan: closureReviewPlan = null, ...closureReview } = row.closure_review || {};
  const needsQuantityReview = quantityReviewPending(quantityReview);
  const dispatchCompleted = row.fulfillment_method === 'mbt_delivery' && Boolean(row.dispatch_completion_event_id);
  const yardPickupCompleted = row.fulfillment_method === 'yard_pickup' && Boolean(row.yard_pickup_completed_at);
  const operationallyComplete = row.operationally_complete === true || dispatchCompleted || yardPickupCompleted;
  const remotelyReconciled = Boolean(row.remotely_reconciled === true
    || (terminalSalesOrder(row) && terminalPurchaseOrder(row)));
  const postPoChangePending = row.post_po_change_pending === true;
  return {
    id: Number(row.request_id),
    ...(closureReview.id ? { closureReview, closureReviewPlan } : {}),
    requestRef: row.request_ref || "",
    requestType: "special",
    status: row.request_status || "submitted",
    revision: Number(row.revision) || 1,
    storeLocationId: Number(row.destination_location_id),
    storeName: row.destination_name || "",
    inquiryDate: dateValue(row.inquiry_date),
    expiresOn: dateValue(row.expires_on),
    netsuiteCustomerId: numberOrNull(row.order_customer_netsuite_id),
    netsuiteCustomerName: row.order_customer_name || "",
    customerId: numberOrNull(row.canonical_customer_id ?? row.directory_customer_id),
    customerName: row.customer_name || "",
    customerPhone: row.customer_phone || "",
    vendorId: numberOrNull(row.vendor_id),
    vendorName: row.vendor_name || "",
    requiredDate: dateValue(row.required_date),
    estimateId: numberOrNull(row.estimate_netsuite_id),
    estimateNumber: row.estimate_ref || "",
    remarks: row.remarks || "",
    salesInternalRemark: row.sales_internal_remark || '',
    informationRequest: row.information_request || null,
    lineEditState: row.line_edit_state || {},
    lineDecisionsNeedReview: row.line_edit_state?.orderReviewRequired === true,
    fulfillmentMethod: row.fulfillment_method || null,
    operationalYardLocationId: numberOrNull(row.operational_yard_location_id),
    deliveryAddress: row.delivery_address || "",
    deliveryContactName: row.delivery_contact_name || "",
    deliveryContactPhone: row.delivery_contact_phone || "",
    palletTotal: numberOrNull(row.pallet_total),
    palletRate: numberOrNull(row.pallet_rate),
    deliveryFeeRate: numberOrNull(/** @type {Record<string,any>} */ (row).delivery_fee_rate),
    deliveryDate: dateValue(row.delivery_date),
    windowStart: timeValue(row.delivery_window_start),
    windowEnd: timeValue(row.delivery_window_end),
    deliveryInstructions: row.delivery_instructions || "",
    salesOrderSource: row.sales_order_source || null,
    salesOrderId: numberOrNull(row.sales_order_netsuite_id),
    salesOrderSkipped: row.sales_order_skipped === true,
    salesOrderRef: row.sales_order_ref || null,
    salesOrderStatus: row.sales_order_status || null,
    salesOrderFulfillmentStatus: row.canonical_sales_fulfillment_status || row.canonical_sales_status_text || row.sales_order_status || null,
    salesOrderFulfilledAt: row.canonical_sales_fulfilled_at || null,
    salesOrderPickupCompletedAt: row.yard_pickup_completed_at || null,
    salesOrderApproved: row.sales_order_approved === true,
    salesOrderOperationStatus: row.sales_order_operation_status || "idle",
    salesOrderOperationId: row.sales_order_operation_id || null,
    salesOrderOperationError: row.sales_order_operation_error || "",
    salesOrderSubmissionStartedAt: row.sales_order_submission_started_at || null,
    netsuiteSalesRepId: numberOrNull(row.netsuite_sales_rep_id),
    netsuiteSalesRepName: row.netsuite_sales_rep_name || '',
    salesDiscountMode: row.sales_discount_mode || 'line',
    vendorDiscountReview: row.vendor_discount_review || {},
    purchaseOrderId: numberOrNull(row.purchase_order_netsuite_id),
    purchaseOrderCustomLinkage: /** @type {Record<string,any>} */ (row).purchase_order_custom_linkage === true,
    purchaseOrderSkipped: row.purchase_order_skipped === true,
    purchaseOrderRef: row.purchase_order_ref || null,
    purchaseOrderStatus: row.effective_purchase_status || row.purchase_order_status || null,
    purchaseOrderApproved: row.purchase_order_approved === true,
    purchaseOrderPendingApproval: row.purchase_order_pending_approval === true,
    purchaseOrderReference: row.purchase_order_reference || '',
    fulfillmentChange: row.fulfillment_change?.id ? { ...row.fulfillment_change, plan: undefined } : null,
    fulfillmentChangePlan: row.fulfillment_change?.plan || null,
    purchaseOrderOperationStatus: row.purchase_order_operation_status || "idle",
    purchaseOrderOperationId: row.purchase_order_operation_id || null,
    purchaseOrderOperationError: row.purchase_order_operation_error || "",
    purchaseOrderSubmissionStartedAt: row.purchase_order_submission_started_at || null,
    closeStatus: row.close_status || "active",
    closureReason: row.closure_reason || "",
    handoffRoute: row.handoff_route || null,
    operationallyComplete,
    operationallyCompletedAt: row.operationally_completed_at || row.yard_pickup_completed_at || row.dispatch_completed_at || null,
    operationalCompletionSource: row.operational_completion_source || (yardPickupCompleted ? "yard_pickup" : dispatchCompleted ? "dispatch_completion" : null),
    operationallyCompletedBy: row.operationally_completed_by || null,
    vendorPickupDate: dateValue(row.vendor_pickup_date),
    vendorPickupReference: row.vendor_pickup_reference || "",
    remotelyReconciled,
    attention: row.attention === true || postPoChangePending || needsQuantityReview || ['applying','attention'].includes(row.fulfillment_change?.status),
    attentionReason: (['applying','attention'].includes(row.fulfillment_change?.status) ? 'Delivery update pending — Sales must finish or retry the saved change.' : '') || row.attention_reason || (needsQuantityReview ? 'Quantity changed — SCM review required.' : postPoChangePending ? "Vendor availability changed after Purchase Order creation; customer acknowledgement is required." : ""),
    quantityReview, quantityReviewPlan, quantityReviewPending: needsQuantityReview,
    postPoChangePending,
    postPoChangeDetails: row.post_po_change_details || {},
    postPoChangeAcknowledgedAt: row.post_po_change_acknowledged_at || null,
    dispatchPlanned: row.canonical_sales_dispatch_planned === true,
    requestedBy: row.requested_by || null,
    requestedByName: row.requested_by_name || row.requested_by || "",
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    lines: [],
    salesOrderLines: [],
    purchaseOrderLines: [],
    media: [],
    handoff: null,
    events: []
  };
}

function stageFor(detail) {
  const lines = detail.lines || [];
  const hasPendingPurchaseResponse = lines.some((line) => !line.supplyStatus || line.salesDecision === "request_update");
  const hasPendingSalesDecision = !hasPendingPurchaseResponse
    && lines.some((line) => !TERMINAL_DECISIONS.has(line.salesDecision));
  const linesResolved = lines.length > 0 && lines.every((line) => TERMINAL_DECISIONS.has(line.salesDecision));
  return specialCaseStageAfterEdits(detail, deriveSpecialCaseStage({
    submitted: detail.status !== "draft",
    pendingUpdate: detail.informationRequest?.status === 'pending',
    hasPendingPurchaseResponse,
    hasPendingSalesDecision,
    linesResolved,
    waitingForProduction: linesResolved && lines.some(line => line.salesDecision === 'accepted' && !specialStockAvailable(line.supplyStatus)),
    fulfillmentMethod: detail.fulfillmentMethod,
    salesOrderId: detail.salesOrderId,
    salesOrderSkipped: detail.salesOrderSkipped,
    salesOrderApproved: detail.salesOrderApproved,
    purchaseOrderId: detail.purchaseOrderId,
    purchaseOrderSkipped: detail.purchaseOrderSkipped,
    purchaseOrderApproved: detail.purchaseOrderApproved,
    needsDispatchRoute: detail.handoff?.status === "waiting_route",
    operationallyComplete: detail.operationallyComplete,
    remotelyReconciled: detail.remotelyReconciled,
    attention: detail.attention,
    closed: detail.closeStatus === "closed" || detail.status === "cancelled"
  }));
}

function assertScope(detail, authorizedStoreLocationIds) {
  if (authorizedStoreLocationIds === undefined) return;
  const authorized = new Set((authorizedStoreLocationIds || []).map(Number));
  if (!authorized.has(Number(detail.storeLocationId))) {
    throw workflowError("This Special Item case is outside your Sales yard access.", 403, "SPECIAL_CASE_STORE_FORBIDDEN");
  }
}

async function selectCaseRows(requestIds, { forUpdate = false } = {}) {
  const result = await query(
    `SELECT request.id AS request_id, request.request_ref, request.status AS request_status,
            request.revision, request.destination_location_id, request.destination_name,
            request.requested_by, request.created_at, request.updated_at, request.remarks,
            operator.display_name AS requested_by_name,
            canonical_sales.status AS canonical_sales_status,
            canonical_sales.status_text AS canonical_sales_status_text,
            canonical_sales.netsuite_active AS canonical_sales_active,
            canonical_sales.fulfillment_status AS canonical_sales_fulfillment_status,
            canonical_sales.fulfilled_at AS canonical_sales_fulfilled_at,
            canonical_sales.dispatch_planned AS canonical_sales_dispatch_planned,
            approval.approved AS purchase_order_approved,
            approval.pending AS purchase_order_pending_approval,
            approval.status_text AS effective_purchase_status,
            canonical_purchase.dispatch_ref AS purchase_order_reference,
            canonical_purchase.status AS canonical_purchase_status,
            canonical_purchase.status_text AS canonical_purchase_status_text,
            canonical_purchase.netsuite_active AS canonical_purchase_active,
            canonical_purchase.receipt_status AS canonical_purchase_receipt_status,
            canonical_purchase.received_at AS canonical_purchase_received_at,
            completion.completion_event_id AS dispatch_completion_event_id,
            completion.dispatch_completed_at,
            (SELECT max(pickup.created_at) FROM operator_load_records pickup
              WHERE pickup.order_id = special.sales_order_netsuite_id
                AND pickup.load_type = 'customer_pickup_load'
                AND pickup.response->>'pickupStatus' = 'loaded') AS yard_pickup_completed_at,
            special.*
       FROM sales_stock_requests request
       JOIN sales_special_stock_cases special ON special.request_id = request.id
       JOIN special_stock_purchase_approval approval ON approval.request_id = special.request_id
       LEFT JOIN operators operator ON operator.id = request.requested_by
       LEFT JOIN sales_orders canonical_sales
         ON canonical_sales.netsuite_id = special.sales_order_netsuite_id
       LEFT JOIN purchase_orders canonical_purchase
         ON canonical_purchase.netsuite_id = special.purchase_order_netsuite_id
       LEFT JOIN dispatch_order_completion_status completion
         ON completion.order_kind = 'SO'
        AND lower(btrim(completion.order_ref)) = lower(btrim(special.sales_order_ref))
      WHERE request.id = ANY($1::bigint[]) AND request.request_type = 'special'
      ${forUpdate ? "FOR UPDATE OF request, special" : ""}`,
    [requestIds]
  );
  return result.rows;
}

async function selectCaseRow(requestId, options) {
  const rows = await selectCaseRows([positiveId(requestId, "Special Item case")], options);
  if (!rows.length) throw workflowError("Special Item case was not found.", 404, "SPECIAL_CASE_NOT_FOUND");
  return rows[0];
}

async function lockCase(requestId, revision) {
  const row = await selectCaseRow(requestId, { forUpdate: true });
  if (Number(row.revision) !== expectedRevision(revision)) {
    throw workflowError("This Special Item case changed. Refresh it before saving.", 409, "SPECIAL_REVISION_CONFLICT");
  }
  return row;
}

async function lockOwnedOrderOperation(requestId, revision, field, operationId) {
  const row = await selectCaseRow(requestId, { forUpdate: true });
  if (!operationId || row[`${field}_operation_id`] !== operationId || row[`${field}_operation_status`] !== 'creating') {
    throw workflowError('This step must own the active order operation.', 409, 'SPECIAL_REMOTE_OPERATION_BUSY');
  }
  // User edits are locked after claim. Webhooks can advance the case revision
  // while the same operation verifies NetSuite and records its durable progress.
  if (Number(row.revision) < expectedRevision(revision)) {
    throw workflowError('This Special Item case changed. Refresh it before saving.', 409, 'SPECIAL_REVISION_CONFLICT');
  }
  return row;
}

async function appendEvent(requestId, eventType, actorId, details = {}, { lineId = null, audience = "all" } = /** @type {{lineId?: number|null, audience?: string}} */ ({})) {
  await query(
    `INSERT INTO sales_special_stock_events (
       request_id, case_line_id, event_type, actor_id, audience, details
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [requestId, lineId, eventType, actorId || null, audience, JSON.stringify(details || {})]
  );
}

async function bumpCase(requestId) {
  const result = await query(
    `UPDATE sales_stock_requests
        SET revision = revision + 1, updated_at = now(),
            status = CASE WHEN status = 'submitted' THEN 'active' ELSE status END
      WHERE id = $1
      RETURNING revision`,
    [requestId]
  );
  await query("UPDATE sales_special_stock_cases SET updated_at = now() WHERE request_id = $1", [requestId]);
  return Number(result.rows[0]?.revision);
}

async function lineRows(requestId, { forUpdate = false } = {}) {
  const result = await query(
    `SELECT * FROM sales_special_stock_lines
      WHERE request_id = $1 ORDER BY line_number
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [requestId]
  );
  return result.rows;
}

async function reconcileCanonicalOrderLines(requestId, orderKind, remoteOrderId, { required = false, reviewedDescriptionChanges = [], quantityReview = {} } = {}) {
  if (orderKind === 'purchase_order' && (await query('SELECT purchase_order_custom_linkage FROM sales_special_stock_cases WHERE request_id=$1', [requestId])).rows[0]?.purchase_order_custom_linkage) {
    const ready = (await query(`SELECT 1 FROM purchase_order_lines WHERE purchase_order_id=$1
      AND netsuite_active IS DISTINCT FROM false AND item_id IS NOT NULL AND quantity>0
      AND item_id NOT IN (10716,-2,4981) AND UPPER(COALESCE(item_type,'')) NOT IN ('DISCOUNT','SUBTOTAL') LIMIT 1`, [remoteOrderId])).rowCount > 0;
    if (!ready) throw workflowError('Wait for the linked PO lines to synchronize.', 409, 'SPECIAL_CUSTOM_PO_LINES_NOT_READY');
    return ready;
  }
  const expected = await query(
    `SELECT id, case_line_id, item_id, item_name, description, quantity, uom, remote_line_id, native_discount_percent
       FROM sales_special_stock_order_lines
      WHERE request_id = $1 AND order_kind = $2
      ORDER BY id
      FOR UPDATE`,
    [requestId, orderKind]
  );
  const sales = orderKind === "sales_order";
  const canonical = await query(
    sales
      ? `SELECT id, line_id, item_id, item_name, item_description AS description,
                quantity, unit AS uom, netsuite_active AS active
           FROM sales_order_lines
          WHERE sales_order_id = $1 AND item_id IS NOT NULL
            AND item_id NOT IN (10716,-2) AND UPPER(COALESCE(item_type,'')) NOT IN ('DISCOUNT','SUBTOTAL')
          ORDER BY id`
      : `SELECT id, line_id, item_id, item_name, item_description AS description,
                quantity, unit AS uom, netsuite_active AS active
           FROM purchase_order_lines
          WHERE purchase_order_id = $1 AND item_id IS NOT NULL
            AND item_id NOT IN (10716,-2,4981) AND UPPER(COALESCE(item_type,'')) NOT IN ('DISCOUNT','SUBTOTAL')
          ORDER BY id`,
    [remoteOrderId]
  );
  if (!canonical.rowCount && !required) return false;
  const canonicalLines=canonical.rows.map(row=>({id:Number(row.id),lineId:Number(row.line_id),itemId:Number(row.item_id),itemName:row.item_name,
    description:row.description,quantity:Number(row.quantity),uom:row.uom,active:row.active}));
  // A confirmed v2 plan accepts only a complete original or target order while
  // NetSuite webhooks race the local commit. It grants no dispatch permission.
  if(quantityReview?.plan?.version===2 && quantityReview.remoteStarted===true && ['applying','attention'].includes(quantityReview.status)){
    const order=quantityReview.plan.orders.find(order=>order.kind===orderKind && order.id===Number(remoteOrderId));
    if(order){
      for(const snapshot of [order.baseline,order.target]){
        try{
          const lines=snapshot.lines.filter(line=>line.itemId!==10716 && (orderKind!=='purchase_order' || line.itemId!==4981)).map((line,index)=>({id:index+1,itemId:line.itemId,itemName:expected.rows.find(row=>Number(row.item_id)===line.itemId)?.item_name || (line.itemId===1784?'PALLET':''),description:line.description,
            quantity:line.quantity,remoteLineId:line.remoteLineId,uom:expected.rows.find(row=>Number(row.remote_line_id)===line.remoteLineId)?.uom || (line.itemId===1784?'EACH':'PC')}));
          matchSpecialOrderCoverage(lines,canonicalLines.filter(line=>line.itemId!==10716),{orderKind});
          return true;
        }catch(error){if(!String(error.code||'').startsWith('SPECIAL_ORDER_'))throw error;}
      }
      throw workflowError('NetSuite order lines differ from the confirmed adjustment.',409,'SPECIAL_ORDER_COVERAGE_MISMATCH');
    }
  }
  // SO and PO discounts are independent. Canonical coverage checks materials only.
  const expectedLines = expected.rows.map((row) => ({
      id: Number(row.id), caseLineId: numberOrNull(row.case_line_id), itemId: Number(row.item_id), itemName: row.item_name,
      description: row.description, quantity: Number(row.quantity), uom: row.uom, remoteLineId: numberOrNull(row.remote_line_id)
    }));
  const mappings = matchSpecialOrderCoverage(
    expectedLines,
    canonicalLines.filter(line=>line.itemId!==10716),
    { orderKind: sales ? "Sales Order" : "Purchase Order", reviewedDescriptionChanges: [
      ...reviewedDescriptionChanges, ...reviewedQuantityTransitions(quantityReview, orderKind, remoteOrderId, expectedLines)
    ] }
  );
  for (const mapping of mappings) {
    await query(
      `UPDATE sales_special_stock_order_lines
          SET remote_line_id = $3, updated_at = now()
        WHERE request_id = $1 AND id = $2`,
      [requestId, mapping.expectedLineId, mapping.remoteLineId]
    );
  }
  return true;
}

async function canonicalLinksReady(requestId) {
  const result = await query(
    `SELECT count(*)::int AS expected,
            count(remote_line_id)::int AS linked
       FROM sales_special_stock_order_lines orders
       JOIN sales_special_stock_cases special ON special.request_id=orders.request_id
      WHERE orders.request_id = $1 AND ancillary = false
        AND (NOT special.purchase_order_custom_linkage OR (orders.order_kind='sales_order' AND EXISTS (
          SELECT 1 FROM purchase_order_lines line WHERE line.purchase_order_id=special.purchase_order_netsuite_id
            AND line.netsuite_active IS DISTINCT FROM false AND line.item_id IS NOT NULL AND line.quantity>0
            AND line.item_id NOT IN (10716,-2,4981) AND UPPER(COALESCE(line.item_type,'')) NOT IN ('DISCOUNT','SUBTOTAL'))))`,
    [requestId]
  );
  return Number(result.rows[0]?.expected) > 0
    && Number(result.rows[0]?.linked) === Number(result.rows[0]?.expected);
}

async function directAllocationLines(requestId, special) {
  if (special.purchase_order_custom_linkage) throw workflowError('Custom linked POs must be arranged via the yard. Direct delivery requires reviewed SO-to-PO line allocations.', 409, 'SPECIAL_CUSTOM_PO_DIRECT_ALLOCATION_REQUIRED');
  const result = await query(
    `SELECT sales_line.id AS sales_line_id,
            purchase_line.id AS purchase_line_id,
            sales_order_line.quantity AS sales_quantity,
            sales_order_line.uom AS sales_uom,
            purchase_order_line.quantity AS purchase_quantity,
            purchase_order_line.uom AS purchase_uom
       FROM sales_special_stock_order_lines sales_order_line
       JOIN sales_special_stock_order_lines purchase_order_line
         ON purchase_order_line.request_id = sales_order_line.request_id
        AND purchase_order_line.case_line_id = sales_order_line.case_line_id
        AND purchase_order_line.order_kind = 'purchase_order'
       JOIN sales_order_lines sales_line
         ON sales_line.sales_order_id = $2
        AND sales_line.line_id = sales_order_line.remote_line_id
       JOIN purchase_order_lines purchase_line
         ON purchase_line.purchase_order_id = $3
        AND purchase_line.line_id = purchase_order_line.remote_line_id
      WHERE sales_order_line.request_id = $1
        AND sales_order_line.order_kind = 'sales_order'
        AND sales_order_line.ancillary = false
      ORDER BY sales_order_line.id`,
    [requestId, special.sales_order_netsuite_id, special.purchase_order_netsuite_id]
  );
  if (!result.rowCount) {
    throw workflowError("The exact SO and PO line relationship has not synchronized yet.", 409, "SPECIAL_ROUTE_LINES_NOT_READY");
  }
  return result.rows.map((row) => ({
    salesLineId: Number(row.sales_line_id),
    poLineId: Number(row.purchase_line_id),
    quantities: { salesQty: Number(row.sales_quantity) }
  }));
}

export async function getSpecialStockCase(requestId, options = {}) {
  return (await hydrateSpecialStockCases([await selectCaseRow(requestId)], options))[0];
}

async function hydrateSpecialStockCases(rows, {
  audience = "scm", authorizedStoreLocationIds = undefined, dispatchPlans = undefined
} = {}) {
  const details = rows.map(mapCase);
  for (const detail of details) assertScope(detail, authorizedStoreLocationIds);
  if (!details.length) return [];
  const ids = details.map(detail => detail.id);
  // Keep these reads sequential: callers may already be inside the ambient
  // transaction, and node-postgres does not support concurrent queries on one
  // transaction client.
  const linesResult = await query("SELECT * FROM sales_special_stock_lines WHERE request_id = ANY($1::bigint[]) ORDER BY line_number", [ids]);
  const orderLinesResult = await query("SELECT * FROM sales_special_stock_order_lines WHERE request_id = ANY($1::bigint[]) ORDER BY order_kind, id", [ids]);
  const mediaResult = await query(
      `SELECT request_id, upload_id, object_ref, mime_type, byte_size, status, attached_sales_order_id,
              registered_at, attached_at, created_at
         FROM sales_special_stock_media
        WHERE request_id = ANY($1::bigint[]) AND status <> 'deleted'
        ORDER BY created_at, upload_id`,
      [ids]
    );
  const handoffResult = await query("SELECT * FROM sales_special_stock_handoffs WHERE request_id = ANY($1::bigint[])", [ids]);
  const eventsResult = await query(
      `SELECT recent.* FROM unnest($1::bigint[]) AS selected(request_id)
       CROSS JOIN LATERAL (
         SELECT event.*, actor.display_name AS actor_name
           FROM sales_special_stock_events event
           LEFT JOIN operators actor ON actor.id = event.actor_id
          WHERE event.request_id = selected.request_id
            AND ($2 = 'scm' OR event.audience <> 'scm')
            AND (event.audience <> 'sales' OR $2 = 'sales')
          ORDER BY event.created_at DESC, event.id DESC LIMIT 100
       ) recent`,
      [ids, audience]
    );
  const plans = dispatchPlans || await readSpecialDispatchPlans();
  const byCase = result => {
    const grouped = new Map();
    for (const row of result.rows) {
      const id = Number(row.request_id);
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(row);
    }
    return grouped;
  };
  const [lines, orderRows, media, handoffs, events] = [linesResult, orderLinesResult, mediaResult, handoffResult, eventsResult].map(byCase);
  return details.map(detail => {
  detail.lines = (lines.get(detail.id) || []).map(mapLine);
  const orderLines = (orderRows.get(detail.id) || []).map(mapOrderLine);
  detail.salesOrderLines = orderLines.filter((line) => line.orderKind === "sales_order");
  detail.purchaseOrderLines = orderLines.filter((line) => line.orderKind === "purchase_order");
  detail.media = (media.get(detail.id) || []).map((row) => ({
    id: row.upload_id,
    objectRef: row.object_ref || null,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    status: row.status,
    attachedSalesOrderId: numberOrNull(row.attached_sales_order_id),
    registeredAt: row.registered_at || null,
    attachedAt: row.attached_at || null
  }));
  const handoff = handoffs.get(detail.id)?.[0];
  if (handoff) {
    const status = detail.operationallyComplete
      ? "completed"
      : detail.postPoChangePending
        ? "attention"
        : detail.dispatchPlanned && handoff.status === "ready"
          ? "planned"
          : handoff.status;
    detail.handoff = {
      requestId: Number(handoff.request_id),
      route: handoff.route || null,
      status,
      salesOrderId: Number(handoff.sales_order_netsuite_id),
      purchaseOrderId: Number(handoff.purchase_order_netsuite_id),
      pickupAddress: handoff.pickup_address,
      destinationAddress: handoff.destination_address,
      operationalYardLocationId: Number(handoff.operational_yard_location_id),
      lines: handoff.line_snapshot || [],
      routeSelectedAt: handoff.route_selected_at || null,
      completedAt: handoff.completed_at || null
    };
  }
  detail.events = (events.get(detail.id) || []).map((row) => ({
    id: Number(row.id),
    lineId: numberOrNull(row.case_line_id),
    eventType: row.event_type,
    actorId: row.actor_id || null,
    actorName: row.actor_name || row.actor_id || "System",
    details: row.details || {},
    createdAt: row.created_at
  }));
  detail.dispatchPlanning = specialDispatchPlanning(detail, plans);
  detail.stage = stageFor(detail);
  detail.stageLabel = SPECIAL_STAGES[/** @type {keyof typeof SPECIAL_STAGES} */ (detail.stage)];
  detail.readinessAlerts = ['closed', 'completed'].includes(detail.stage) ? [] : detail.lines
    .filter(line => line.salesDecision === 'accepted' && !specialStockAvailable(line.supplyStatus)
      && line.reminderDueDate && line.reminderDueDate <= torontoDate())
    .map(line => ({ lineId: line.id, productName: line.productName, eta: line.availableDate, dueDate: line.reminderDueDate }));
  return projectSpecialStockCase(detail, audience);
  });
}

export async function listSpecialStockCases({
  audience = "scm",
  authorizedStoreLocationIds = undefined,
  stage = "",
  stages = undefined,
  search = "",
  storeLocationId = "",
  storeLocationIds = undefined,
  vendorNames = undefined,
  requestedByOperatorId = undefined,
  limit = 60,
  offset = 0
} = {}) {
  const clauses = ["request.request_type = 'special'"];
  const params = [];
  const selectedVendors = parseVendorNames(vendorNames);
  if (selectedVendors.length) {
    params.push(selectedVendors);
    clauses.push(`special.vendor_name = ANY($${params.length}::text[])`);
  }
  if (requestedByOperatorId) {
    params.push(String(requestedByOperatorId));
    clauses.push(`request.requested_by = $${params.length}`);
  }
  const selectedStages = parseStages(stages ?? stage);
  if (selectedStages.length) {
    params.push(selectedStages);
    clauses.push(`workflow.stage = ANY($${params.length}::text[])`);
  }
  if (authorizedStoreLocationIds !== undefined) {
    const ids = [...new Set((authorizedStoreLocationIds || []).map(Number).filter(Number.isSafeInteger))];
    if (!ids.length) return [];
    params.push(ids);
    clauses.push(`request.destination_location_id = ANY($${params.length}::bigint[])`);
  }
  if (storeLocationId !== "" && storeLocationId != null) {
    params.push(positiveId(storeLocationId, "Yard"));
    clauses.push(`request.destination_location_id = $${params.length}`);
  }
  const selectedYards = parseYardIds(storeLocationIds);
  if (selectedYards.length) {
    params.push(selectedYards);
    clauses.push(`request.destination_location_id = ANY($${params.length}::bigint[])`);
  }
  const normalizedSearch = cleanSearch(search);
  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    clauses.push(`(
      request.request_ref ILIKE $${params.length}
      OR special.customer_name ILIKE $${params.length}
      OR special.vendor_name ILIKE $${params.length}
      OR COALESCE(special.sales_order_ref, '') ILIKE $${params.length}
      OR COALESCE(special.purchase_order_ref, '') ILIKE $${params.length}
      OR EXISTS (
        SELECT 1 FROM sales_special_stock_lines line
         WHERE line.request_id = request.id
           AND (line.product_name ILIKE $${params.length} OR line.brand ILIKE $${params.length})
      )
    )`);
  }
  params.push(optionalLimit(limit));
  const limitIndex = params.length;
  params.push(Math.max(0, Math.trunc(Number(offset) || 0)));
  const result = await query(
    `SELECT request.id AS request_id, request.request_ref, request.status AS request_status,
            request.revision, request.destination_location_id, request.destination_name,
            request.requested_by, request.created_at, request.updated_at, request.remarks,
            operator.display_name AS requested_by_name, special.*
       FROM sales_stock_requests request
       JOIN sales_special_stock_cases special ON special.request_id = request.id
       JOIN special_stock_workflow_stages workflow ON workflow.request_id = request.id
       LEFT JOIN operators operator ON operator.id = request.requested_by
      WHERE ${clauses.join(" AND ")}
      ORDER BY ${audience === 'scm' ? "COALESCE(special.close_status = 'closure_pending' AND COALESCE(special.closure_review->>'id','') <> '' AND special.closure_review->>'status' IN ('pending','attention'),false) DESC," : ''}
               COALESCE(special.quantity_review->>'status' IN ('pending','applying','attention'),false) DESC,
               special.attention DESC, request.updated_at DESC, request.id DESC
      LIMIT $${limitIndex} OFFSET $${limitIndex + 1}`,
    params
  );
  if (!result.rowCount) return [];
  const rows = await selectCaseRows(result.rows.map(row => Number(row.request_id)));
  const details = await hydrateSpecialStockCases(rows, { audience, authorizedStoreLocationIds });
  const byId = new Map(details.map(detail => [detail.id, detail]));
  return result.rows.map(row => byId.get(Number(row.request_id))).filter(Boolean);
}

export async function createSpecialStockCase(input, { operatorId, authorizedStoreLocationIds = [] } = {}) {
  const draft = normalizeSpecialCaseDraft(input, { authorizedStoreLocationIds });
  const actorId = String(operatorId || "").trim();
  if (!actorId) throw workflowError("An authenticated Sales operator is required.", 401, "SPECIAL_ACTOR_REQUIRED");
  const requestId = await withTransaction(async () => {
    let customerName = draft.customerName;
    let customerPhone = draft.customerPhone;
    const customer = draft.customerId ? await findSpecialCustomer(draft.customerId) : null;
    if (draft.customerId) {
      if (!customer) throw workflowError('Select an active NetSuite customer.',409,'SPECIAL_CASE_CUSTOMER_INVALID');
      customerName = customer.name || customerName;
      customerPhone = customer.phone || customerPhone;
    }
    const request = await query(
      `INSERT INTO sales_stock_requests (
         request_ref, request_type, destination_location_id, destination_name,
         status, revision, requested_by, remarks
       ) VALUES (
         'SPREQ-' || LPAD(nextval('sales_special_stock_request_ref_seq')::text, 6, '0'),
         'special', $1, $2, 'submitted', 1, $3, $4
       ) RETURNING id`,
      [draft.storeLocationId, YARD_NAMES.get(draft.storeLocationId), actorId, draft.remarks]
    );
    const id = Number(request.rows[0].id);
    await query(
      `INSERT INTO sales_special_stock_cases (
         request_id, inquiry_date, customer_name, customer_phone,
         canonical_customer_id, vendor_id, vendor_name, required_date,
         estimate_netsuite_id, estimate_ref, fulfillment_method, operational_yard_location_id,
         delivery_address, delivery_contact_name, delivery_contact_phone, delivery_date,
         delivery_window_start, delivery_window_end, delivery_instructions, directory_customer_id,
         expires_on, netsuite_sales_rep_id, netsuite_sales_rep_name, pallet_total, pallet_rate, delivery_fee_rate, sales_internal_remark
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
      [
        id, draft.inquiryDate, customerName, customerPhone,
        customer?.canonicalId ?? null, draft.vendorId, draft.vendorName, draft.requiredDate,
        draft.estimateId, draft.estimateNumber || null, draft.fulfillmentMethod, draft.storeLocationId,
        draft.deliveryAddress, draft.deliveryContactName, draft.deliveryContactPhone,
        draft.deliveryDate, draft.windowStart, draft.windowEnd, draft.deliveryInstructions, customer?.directoryId ?? null,
        draft.expiresOn, draft.netsuiteSalesRepId, draft.netsuiteSalesRepName, draft.palletTotal, draft.palletRate, draft.deliveryFeeRate, draft.salesInternalRemark
      ]
    );
    for (const [index, line] of draft.lines.entries()) {
      await query(
        `INSERT INTO sales_special_stock_lines (
           request_id, line_number, brand, product_name, color, size,
           requested_quantity, requested_uom, required_date,
           estimate_line_reference, customer_note, original_unit_rate, original_rate_uom,
           pricing_source, quoted_discount_percent, discount_percent, scm_reviewed_quantity,
           detail_spec, pack_pallet_qty, pack_layer_qty, pack_section_qty, pack_piece_qty
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$8,'enquiry',$13,$13,$7,$14,$15,$16,$17,$18)`,
        [
          id, index + 1, line.brand || draft.vendorName, line.productName, line.color, line.size,
          line.quantity, line.uom, line.requiredDate,
          line.estimateLineReference, line.customerNote, line.rate, line.discountPercent,
          line.detailSpec, line.palletQty, line.layerQty, line.sectionQty, line.pieceQty
        ]
      );
    }
    await appendEvent(id, "special_case_submitted", actorId, {
      storeLocationId: draft.storeLocationId,
      lineCount: draft.lines.length,
      vendorName: draft.vendorName
    });
    return id;
  });
  return getSpecialStockCase(requestId, { audience: "sales", authorizedStoreLocationIds, dispatchPlans: [] });
}

/** @param {number|string} requestId @param {{expectedRevision?:unknown,lines?:unknown}} input @param {{operatorId?:string,authorizedStoreLocationIds?:number[]}} context */
export async function addSpecialStockItems(requestId, input = {}, {operatorId,authorizedStoreLocationIds = []} = {}) {
  const id = positiveId(requestId,'Special Item case');
  const actorId = String(operatorId || '').trim();
  if (!actorId) throw workflowError('An authenticated Sales operator is required.',401,'SPECIAL_ACTOR_REQUIRED');
  await withTransaction(async () => {
    const special = await lockCase(id,input.expectedRevision);
    const detail = mapCase(special);
    assertScope(detail,authorizedStoreLocationIds);
    if (!canAddSpecialItems(detail)) {
      throw workflowError('Items can only be added to an active request before creating a Sales Order. Resolve any pending operation first.',409,'SPECIAL_ITEMS_LOCKED');
    }
    /** @type {Array<{line_number:number|string}>} */
    const existing = await lineRows(id,{forUpdate:true});
    const lines = normalizeSpecialAdditionalLines(input.lines,{existingLineCount:existing.length});
    const lastNumber = Math.max(...existing.map(line => Number(line.line_number)));
    for (const [index,line] of lines.entries()) {
      await query(`INSERT INTO sales_special_stock_lines (
        request_id,line_number,brand,product_name,color,size,requested_quantity,requested_uom,required_date,
        estimate_line_reference,customer_note,original_unit_rate,original_rate_uom,pricing_source,
        quoted_discount_percent,discount_percent,scm_reviewed_quantity,detail_spec,pack_pallet_qty,pack_layer_qty,pack_section_qty,pack_piece_qty
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$8,'enquiry',$13,$13,$7,$14,$15,$16,$17,$18)`,
      [id,lastNumber + index + 1,special.vendor_name,line.productName,line.color,line.size,line.quantity,line.uom,line.requiredDate,
        line.estimateLineReference,line.customerNote,line.rate,line.discountPercent,line.detailSpec,line.palletQty,line.layerQty,line.sectionQty,line.pieceQty]);
    }
    // An unsent SO draft cannot retain a material list that omits the new items.
    await query("DELETE FROM sales_special_stock_order_lines WHERE request_id=$1 AND order_kind='sales_order'",[id]);
    await bumpCase(id);
    await appendEvent(id,'special_items_added',actorId,{lineCount:lines.length,previousLineCount:existing.length});
  });
  return getSpecialStockCase(id,{audience:'sales',authorizedStoreLocationIds});
}

/** @param {number} requestId @param {Record<string,any>} row @param {import('../public/special-stock-case-edits.js').CaseLineEdit} change @param {string} actorId */
async function restartEditedCaseLine(requestId, row, change, actorId) {
  // Preserve invalidated private review evidence for SCM without disclosing it to Sales.
  await appendEvent(requestId, 'special_case_line_review_invalidated', actorId, { before: row }, { lineId: row.id, audience: 'scm' });
  await query(`UPDATE sales_special_stock_lines SET product_name=$3,requested_quantity=$4,original_unit_rate=$5,
    original_rate_uom=CASE WHEN original_unit_rate IS NULL THEN COALESCE(original_rate_uom,$6) ELSE original_rate_uom END,
    pricing_source=CASE WHEN original_unit_rate IS NULL THEN 'legacy_entry' ELSE pricing_source END,
    supply_status=NULL,availability_mode=NULL,available_date=NULL,response_vendor_id=NULL,response_vendor_name=NULL,
    vendor_yard=NULL,vendor_reference=NULL,sales_visible_note='',scm_internal_note='',unit_purchase_cost=NULL,purchase_currency=NULL,
    resolved_item_id=NULL,resolved_item_name=NULL,resolved_description=NULL,sales_uom=NULL,purchase_uom=NULL,
    sales_quantity=NULL,purchase_quantity=NULL,pallet_quantity=NULL,sales_package_quantity=NULL,pieces_per_unit=NULL,
    scm_reviewed_quantity=$4,scm_reviewed_pieces_per_unit=NULL,sales_decision='pending',sales_decision_reason='',sales_customer_note='',decline_restore='{}',
    response_revision=response_revision+1,decision_revision=decision_revision+1,responded_by=NULL,responded_at=NULL,
    decided_by=NULL,decided_at=NULL,stock_checked_by=NULL,stock_checked_at=NULL,reminder_due_date=NULL,
    po_ready=false,po_ready_by=NULL,po_ready_at=NULL,po_ready_response_revision=NULL,updated_at=now()
    WHERE request_id=$1 AND id=$2`, [requestId, row.id, change.productName, change.quantity, change.rate, mapLine(row).rateUom]);
}

/** @param {number} requestId @param {Record<string,any>} row @param {Record<string,any>} material @param {import('../public/special-stock-case-edits.js').CaseLineEdit} change @param {Array<Record<string,any>>} savedOrderLines @param {boolean} restart */
async function updateEditedCaseRate(requestId, row, material, change, savedOrderLines, restart) {
  await query(`UPDATE sales_special_stock_lines SET original_unit_rate=$3,
    original_rate_uom=CASE WHEN original_unit_rate IS NULL THEN COALESCE(original_rate_uom,$4) ELSE original_rate_uom END,
    pricing_source=CASE WHEN original_unit_rate IS NULL THEN 'legacy_entry' ELSE pricing_source END,updated_at=now()
    WHERE request_id=$1 AND id=$2`, [requestId, row.id, change.rate, material.rateUom]);
  const draft = savedOrderLines.find(line => line.order_kind === 'sales_order' && Number(line.case_line_id) === Number(row.id));
  if (restart || !draft) return;
  const pricing = draft.native_discount_percent == null ? specialNativePricing : specialNativeLinePricing;
  const converted = pricing({ quantity: material.packageQuantity ?? material.quantity, rate: change.rate,
    discountPercent: material.discountPercent, conversionToPc: material.conversionToPc ?? Number(draft.quantity) / change.quantity });
  if (converted.quantity !== Number(draft.quantity)) throw workflowError('Review the saved SO quantity conversion before editing its price.', 409, 'SPECIAL_CASE_EDIT_LOCKED');
  await query('UPDATE sales_special_stock_order_lines SET unit_rate=$2,updated_at=now() WHERE id=$1', [draft.id, converted.rate]);
}

/** @param {number} requestId @param {{quantity:number,rate:number|null}} pallet @param {Array<Record<string,any>>} savedOrderLines @param {boolean} restart */
async function updateEditedCasePallet(requestId, pallet, savedOrderLines, restart) {
  await query('UPDATE sales_special_stock_cases SET pallet_total=$2,pallet_rate=$3 WHERE request_id=$1', [requestId, pallet.quantity, pallet.rate]);
  if (restart || !savedOrderLines.some(line => line.order_kind === 'sales_order' && !line.ancillary)) return;
  const saved = savedOrderLines.filter(line => line.order_kind === 'sales_order' && Number(line.item_id) === 1784);
  if (saved.length > 1) throw workflowError('Review the duplicate PALLET draft lines before editing.', 409, 'SPECIAL_CASE_EDIT_LOCKED');
  if (!pallet.quantity) {
    await query("DELETE FROM sales_special_stock_order_lines WHERE request_id=$1 AND order_kind='sales_order' AND item_id=1784", [requestId]);
  } else if (saved.length) {
    await query('UPDATE sales_special_stock_order_lines SET quantity=$2,unit_rate=$3,updated_at=now() WHERE id=$1', [saved[0].id, pallet.quantity, pallet.rate]);
  } else {
    const item = (await query('SELECT item_name FROM inventory_items WHERE item_id=1784 FOR SHARE')).rows[0];
    if (!item) throw workflowError('PALLET is missing from the synced item master.', 409, 'SPECIAL_SO_ITEM_NOT_FOUND');
    await query(`INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_rate)
      VALUES($1,'sales_order',true,1784,$2,'PALLET',$3,'EACH',$4)`, [requestId, item.item_name, pallet.quantity, pallet.rate]);
  }
}

/** @param {number} requestId @param {number} rate @param {Array<Record<string,any>>} savedOrderLines @param {boolean} restart */
async function updateEditedCaseDeliveryFee(requestId, rate, savedOrderLines, restart) {
  await query('UPDATE sales_special_stock_cases SET delivery_fee_rate=$2 WHERE request_id=$1', [requestId, rate]);
  if (restart || !savedOrderLines.some(line => line.order_kind === 'sales_order' && !line.ancillary)) return;
  const saved = savedOrderLines.filter(line => line.order_kind === 'sales_order' && line.ancillary && Number(line.item_id) === 1987);
  if (saved.length) {
    await query("UPDATE sales_special_stock_order_lines SET description='Delivery Charge',quantity=1,uom=NULL,unit_rate=$2,updated_at=now() WHERE id=$1", [saved[0].id, rate]);
    if (saved.length > 1) await query('DELETE FROM sales_special_stock_order_lines WHERE id=ANY($1::bigint[])', [saved.slice(1).map(line => line.id)]);
  } else {
    const item = (await query('SELECT item_name FROM inventory_items WHERE item_id=1987 FOR SHARE')).rows[0];
    if (!item) throw workflowError('Delivery Charge is missing from the synced item master.', 409, 'SPECIAL_SO_ITEM_NOT_FOUND');
    await query(`INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_rate)
      VALUES($1,'sales_order',true,1987,$2,'Delivery Charge',1,NULL,$3)`, [requestId, item.item_name, rate]);
  }
}

/** @param {number|string} requestId @param {Record<string,any>} input @param {{operatorId?:string,authorizedStoreLocationIds?:number[]}} context */
export async function editSpecialStockCaseLines(requestId, input = {}, { operatorId, authorizedStoreLocationIds = [] } = {}) {
  const id = positiveId(requestId, 'Special Item case'), actorId = String(operatorId || '').trim();
  if (!actorId) throw workflowError('An authenticated Sales operator is required.', 401, 'SPECIAL_ACTOR_REQUIRED');
  await withTransaction(async () => {
    const special = await lockCase(id, input.expectedRevision);
    const detail = /** @type {Record<string,any>&{lines:ReturnType<typeof mapLine>[]}} */ (mapCase(special));
    assertScope(detail, authorizedStoreLocationIds);
    if (!canEditSpecialCaseLines(detail)) {
      throw workflowError('Case lines can only be edited on an active request before Sales Order creation. Resolve pending operations first.', 409, 'SPECIAL_CASE_EDIT_LOCKED');
    }
    const rows = /** @type {Array<Record<string,any>>} */ (await lineRows(id, { forUpdate: true }));
    const savedOrderLines = /** @type {Array<Record<string,any>>} */ ((await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id FOR UPDATE', [id])).rows);
    if (savedOrderLines.some(line => line.remote_line_id != null)) throw workflowError('Issued order lines cannot be edited here.', 409, 'SPECIAL_CASE_EDIT_LOCKED');
    detail.lines = rows.map(mapLine); detail.salesOrderLines = savedOrderLines.filter(line => line.order_kind === 'sales_order').map(mapOrderLine);
    const tax = (await query('SELECT data FROM field_sales_settings WHERE singleton')).rows[0]?.data?.companies?.MBBS?.taxBps;
    const plan = planSpecialCaseEdits(detail, input, { taxBps: Number.isInteger(tax) && tax >= 0 && tax <= 10000 ? tax : 0 });
    if (!plan.lines.length && !plan.pallet && plan.deliveryFeeRate === undefined && !plan.decisions?.length) return;
    const previousEdit = (await query("SELECT current_setting('mbbs.special_case_edit_request',true) AS edit")).rows[0]?.edit || '';
    await query("SELECT set_config('mbbs.special_case_edit_request',$1,true)", [String(id)]);
    for (const change of plan.lines) {
      const row = /** @type {Record<string,any>} */ (rows.find(line => Number(line.id) === change.lineId));
      const material = /** @type {ReturnType<typeof mapLine>} */ (detail.lines.find(line => line.id === change.lineId));
      if (change.nameChanged || change.quantityChanged) await restartEditedCaseLine(id, row, change, actorId);
      else await updateEditedCaseRate(id, row, material, change, savedOrderLines, plan.restart);
    }
    await query("SELECT set_config('mbbs.special_case_edit_request',$1,true)", [previousEdit]);
    if (plan.pallet) await updateEditedCasePallet(id, plan.pallet, savedOrderLines, plan.restart);
    if (plan.deliveryFeeRate !== undefined) await updateEditedCaseDeliveryFee(id, plan.deliveryFeeRate, savedOrderLines, plan.restart);
    if (plan.restart) await query('DELETE FROM sales_special_stock_order_lines WHERE request_id=$1', [id]);
    // Read after material edits: a fresh stock check must never restore an old acceptance.
    const currentRows = /** @type {Array<Record<string,any>>} */ (plan.decisions?.length ? await lineRows(id) : []);
    for (const change of plan.decisions || []) {
      const row = /** @type {Record<string,any>} */ (currentRows.find(line => Number(line.id) === change.lineId));
      const decision = change.declined ? 'declined' : revokeSpecialLineDecision(mapLine(row));
      const restore = change.declined ? { decision: row.sales_decision, responseRevision: Number(row.response_revision) } : {};
      await query(`UPDATE sales_special_stock_lines SET sales_decision=$3,decline_restore=$4::jsonb,
        decision_revision=decision_revision+1,decided_by=$5,decided_at=now(),updated_at=now()
        WHERE request_id=$1 AND id=$2`, [id, change.lineId, decision, JSON.stringify(restore), actorId]);
      await appendEvent(id, change.declined ? 'special_line_declined' : 'special_line_decline_revoked', actorId,
        { from: row.sales_decision, to: decision }, { lineId: change.lineId, audience: 'sales_scm' });
    }
    const lineEditState = { ...(detail.lineEditState.orderReviewRequired || plan.decisions?.length ? { orderReviewRequired: true } : {}),
      ...(plan.restart && plan.decisions?.length ? { stage: 'new_enquiry', revision: detail.revision + 1 }
        : !plan.restart && (plan.decisions?.length || Number(detail.lineEditState.revision) === detail.revision)
          ? { stage: stageFor(detail), revision: detail.revision + 1 } : {}) };
    await query(`UPDATE sales_special_stock_cases SET
      line_edit_state=$3::jsonb,
      quantity_review=CASE WHEN $2 THEN '{}'::jsonb ELSE quantity_review END,
      vendor_discount_review=CASE WHEN $2 THEN '{}'::jsonb ELSE vendor_discount_review END,updated_at=now() WHERE request_id=$1`, [id, plan.restart, JSON.stringify(lineEditState)]);
    await query(`UPDATE sales_stock_requests SET revision=revision+1,updated_at=now(),
      status=CASE WHEN $2 THEN 'submitted' ELSE status END WHERE id=$1`, [id, plan.restart]);
    await appendEvent(id, 'special_case_lines_edited', actorId, { restarted: plan.restart,
      lines: plan.lines.map(change => { const before = /** @type {ReturnType<typeof mapLine>} */ (detail.lines.find(line => line.id === change.lineId));
        return { lineId: change.lineId, from: { productName: before.productName, quantity: before.packageQuantity ?? before.quantity, rate: before.originalRate },
          to: { productName: change.productName, quantity: change.quantity, rate: change.rate } }; }), pallet: plan.pallet,
      ...(plan.deliveryFeeRate !== undefined ? { deliveryFeeRate: plan.deliveryFeeRate } : {}),
      ...(plan.decisions?.length ? { decisions: plan.decisions } : {}) });
  });
  return getSpecialStockCase(id, { audience: 'sales', authorizedStoreLocationIds });
}

async function writeSpecialSupplyResponse(requestId, lineId, input, { operatorId } = {}) {
  const response = normalizeSpecialSupplyResponse(input);
  const id = positiveId(requestId, "Special Item case");
  const targetLineId = positiveId(lineId, "case line");
  const special = await lockCase(id, input.expectedRevision);
  assertCaseEditable(special);
  if (special.close_status !== "active") throw workflowError("A closing or closed case cannot be changed.", 409, "SPECIAL_CASE_CLOSED");
  const lines = await lineRows(id, { forUpdate: true });
  const target = lines.find((line) => Number(line.id) === targetLineId);
  if (!target) throw workflowError("Special Item line was not found.", 404, "SPECIAL_LINE_NOT_FOUND");
  const vendorIds = new Set(lines
    .filter((line) => Number(line.id) !== targetLineId)
    .map((line) => Number(line.response_vendor_id))
    .filter((vendorId) => Number.isSafeInteger(vendorId) && vendorId > 0));
  if (vendorIds.size > 0 && !vendorIds.has(response.vendorId)) {
    throw workflowError("Every line in a Special Item case must use the same vendor.", 409, "SPECIAL_RESPONSE_MIXED_VENDOR");
  }
  if (special.vendor_id && Number(special.vendor_id) !== response.vendorId) {
    throw workflowError("The response vendor differs from the case vendor.", 409, "SPECIAL_RESPONSE_MIXED_VENDOR");
  }
  if (special.sales_order_netsuite_id || special.sales_order_skipped) throw workflowError('Use the readiness check for availability and the PO review for purchase details after SO creation.', 409, 'SPECIAL_RESPONSE_USE_REVIEW');
  await query(
    `UPDATE sales_special_stock_lines
        SET supply_status = $3, availability_mode = $4, available_date = $5,
            response_vendor_id = $6, response_vendor_name = $7, brand = $7,
            product_name = COALESCE($15, product_name),
            vendor_yard = $8, vendor_reference = $9,
            sales_visible_note = $10, scm_internal_note = $11,
            unit_purchase_cost = $12, purchase_currency = $13,
            sales_decision = CASE WHEN sales_decision = 'request_update' THEN 'pending' ELSE sales_decision END,
            po_ready = false, po_ready_by = NULL, po_ready_at = NULL,
            po_ready_response_revision = NULL,
            response_revision = response_revision + 1,
            responded_by = $14, responded_at = now(), updated_at = now()
      WHERE request_id = $1 AND id = $2`,
    [
      id, targetLineId, response.supplyStatus, response.availabilityMode, response.availableDate,
      response.vendorId, response.vendorName, response.vendorYard, response.vendorReference,
      response.salesVisibleNote, response.scmInternalNote, response.unitPurchaseCost, response.currency,
      operatorId, response.productName ?? null
    ]
  );
  await query('UPDATE sales_special_stock_lines SET reminder_due_date=$3, stock_checked_at=now(), stock_checked_by=$4 WHERE request_id=$1 AND id=$2',
    [id, targetLineId, nextReminderDate({ previousDue: dateValue(target.reminder_due_date), eta: response.availableDate, ready: specialStockAvailable(response.supplyStatus) }), operatorId]);
  const productName = response.productName ?? target.product_name;
  if (target.brand !== response.vendorName || target.product_name !== productName) {
    await appendEvent(id, 'special_item_name_corrected', operatorId, {
      previousBrand: target.brand, brand: response.vendorName,
      previousProductName: target.product_name, productName
    }, { lineId: targetLineId, audience: 'sales_scm' });
  }
  await query(
    `UPDATE sales_special_stock_cases
        SET vendor_id = COALESCE(vendor_id, $2), vendor_name = $3,
            updated_at = now()
      WHERE request_id = $1`,
    [id, response.vendorId, response.vendorName]
  );
  await query(
    `UPDATE sales_stock_requests
        SET first_scm_decision_at = COALESCE(first_scm_decision_at, now())
      WHERE id = $1`,
    [id]
  );
  await appendEvent(id, "special_supply_response_saved", operatorId, {
    supplyStatus: response.supplyStatus,
    availabilityMode: response.availabilityMode,
    availableDate: response.availableDate,
    vendorName: response.vendorName,
    poReady: false
  }, { lineId: targetLineId, audience: "sales_scm" });
  await appendEvent(id, "special_supply_cost_recorded", operatorId, {
    unitPurchaseCost: response.unitPurchaseCost,
    currency: response.currency,
    internalNote: response.scmInternalNote
  }, { lineId: targetLineId, audience: "scm" });
}

/** @param {unknown} value */
function informationNote(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw workflowError('Enter the information requested or supplied (1 to 4000 characters).', 400, 'SPECIAL_INFORMATION_REQUIRED');
  }
  return value.trim().replace(/\r\n?/g, '\n');
}

/** @param {number|string} requestId @param {Record<string,any>} input @param {{operatorId?:string,authorizedStoreLocationIds?:number[]}} context @param {boolean} answering */
async function changeSpecialInformation(requestId, input, context, answering) {
  const note = informationNote(answering ? input.reply : input.question);
  const id = positiveId(requestId, 'Special Item case'), actor = String(context.operatorId || '').trim();
  if (!actor) throw workflowError('An authenticated operator is required.', 401, 'SPECIAL_ACTOR_REQUIRED');
  await withTransaction(async () => {
    const special = await lockCase(id, input.expectedRevision);
    if (answering) assertScope(mapCase(special), context.authorizedStoreLocationIds || []);
    assertCaseEditable(special, { allowPendingUpdate: answering });
    if (special.close_status !== 'active' || mapCase(special).operationallyComplete || special.sales_order_netsuite_id
      || special.purchase_order_netsuite_id || special.sales_order_skipped || special.purchase_order_skipped) {
      throw workflowError('Information can only be requested before stock checking on an active enquiry.', 409, 'SPECIAL_INFORMATION_LOCKED');
    }
    if (answering && special.information_request?.status !== 'pending') {
      throw workflowError('This request is not waiting for a Sales update.', 409, 'SPECIAL_UPDATE_NOT_PENDING');
    }
    if (!answering && !(await lineRows(id)).some(/** @param {Record<string,any>} line */ line => !line.supply_status || line.sales_decision === 'request_update')) {
      throw workflowError('The stock check has already been completed.', 409, 'SPECIAL_INFORMATION_LOCKED');
    }
    const now = new Date().toISOString();
    const information = answering ? { ...special.information_request, status: 'answered', reply: note, answeredBy: actor, answeredAt: now }
      : { status: 'pending', question: note, requestedBy: actor, requestedAt: now };
    await query('UPDATE sales_special_stock_cases SET information_request=$2::jsonb,updated_at=now() WHERE request_id=$1', [id, JSON.stringify(information)]);
    await appendEvent(id, answering ? 'special_information_updated' : 'special_information_requested', actor, information, { audience: 'sales_scm' });
    await bumpCase(id);
  });
  return getSpecialStockCase(id, answering ? { audience: 'sales', authorizedStoreLocationIds: context.authorizedStoreLocationIds || [] } : { audience: 'scm' });
}

/** @param {number|string} requestId @param {Record<string,any>} input @param {{operatorId?:string,authorizedStoreLocationIds?:number[]}} context */
export async function requestSpecialStockInformation(requestId, input = {}, context = {}) {
  return changeSpecialInformation(requestId, input, context, false);
}

/** @param {number|string} requestId @param {Record<string,any>} input @param {{operatorId?:string,authorizedStoreLocationIds?:number[]}} context */
export async function submitSpecialStockInformation(requestId, input = {}, context = {}) {
  return changeSpecialInformation(requestId, input, context, true);
}

export async function respondSpecialStockLine(requestId, lineId, input = {}, context = {}) {
  await withTransaction(async () => {
    await writeSpecialSupplyResponse(requestId, lineId, input, context);
    await bumpCase(positiveId(requestId, 'Special Item case'));
  });
  return getSpecialStockCase(requestId, { audience: 'scm' });
}

async function writeSpecialCustomerDecision(requestId, lineId, input, {
  operatorId,
  authorizedStoreLocationIds = []
} = {}) {
  const decision = normalizeSpecialSalesDecision(input);
  const id = positiveId(requestId, "Special Item case");
  const targetLineId = positiveId(lineId, "case line");
  const special = await lockCase(id, input.expectedRevision);
  assertCaseEditable(special);
  assertScope(mapCase(special), authorizedStoreLocationIds);
  if (special.close_status !== "active" || special.sales_order_netsuite_id || special.purchase_order_netsuite_id || special.sales_order_skipped || special.purchase_order_skipped) {
    throw workflowError("This case can no longer change customer line decisions.", 409, "SPECIAL_DECISION_LOCKED");
  }
  const lineResult = await query(
    "SELECT * FROM sales_special_stock_lines WHERE request_id = $1 AND id = $2 FOR UPDATE",
    [id, targetLineId]
  );
  const line = lineResult.rows[0];
  if (!line) throw workflowError("Special Item line was not found.", 404, "SPECIAL_LINE_NOT_FOUND");
  if (!line.supply_status) throw workflowError("SCM must respond before Sales records a customer decision.", 409, "SPECIAL_DECISION_RESPONSE_REQUIRED");
  let resolution = null;
  if (decision.decision === 'accepted' && !specialStockAvailable(line.supply_status) && !line.available_date) {
    throw workflowError('SCM must provide an ETA before the customer can choose to wait.', 409, 'SPECIAL_ETA_REQUIRED');
  }
  if (decision.decision === "accepted" && decision.itemResolution) {
    const item = await query(
      `SELECT item_id, item_name
         FROM inventory_items
        WHERE item_id = $1
        FOR SHARE`,
      [decision.itemResolution.itemId]
    );
    if (!item.rowCount) {
      throw workflowError(
        "Select an exact item from the synced NetSuite Item Master.",
        409,
        "SPECIAL_DECISION_ITEM_NOT_FOUND"
      );
    }
    resolution = {
      ...decision.itemResolution,
      itemName: item.rows[0].item_name
    };
  }
  await query(
    `UPDATE sales_special_stock_lines
        SET sales_decision = $3, sales_decision_reason = $4, decline_restore='{}',
            sales_customer_note = $5, decision_revision = decision_revision + 1,
            resolved_item_id = $6, resolved_item_name = $7,
            resolved_description = $8, sales_uom = $9, purchase_uom = $10,
            sales_quantity = $11, purchase_quantity = $12, pallet_quantity = $13,
            po_ready = false, po_ready_by = NULL, po_ready_at = NULL,
            po_ready_response_revision = NULL,
            decided_by = $14, decided_at = now(), updated_at = now()
      WHERE request_id = $1 AND id = $2`,
    [
      id, targetLineId, decision.decision, decision.reason, decision.customerNote,
      resolution?.itemId ?? null, resolution?.itemName ?? null, resolution?.description ?? null,
      resolution?.salesUom ?? null, resolution?.purchaseUom ?? null,
      resolution?.salesQuantity ?? null, resolution?.purchaseQuantity ?? null,
      resolution?.palletQuantity ?? null, operatorId
    ]
  );
  await appendEvent(id, "special_customer_decision_saved", operatorId, {
    decision: decision.decision,
    customerNote: decision.customerNote,
    reason: decision.reason,
    itemId: resolution?.itemId ?? null,
    salesQuantity: resolution?.salesQuantity ?? null,
    salesUom: resolution?.salesUom ?? null
  }, {
    lineId: targetLineId,
    audience: "sales_scm"
  });
}

export async function decideSpecialStockLine(requestId, lineId, input = {}, context = {}) {
  await withTransaction(async () => {
    await writeSpecialCustomerDecision(requestId, lineId, input, context);
    await bumpCase(positiveId(requestId, 'Special Item case'));
  });
  return getSpecialStockCase(requestId, { audience: 'sales', authorizedStoreLocationIds: context.authorizedStoreLocationIds || [] });
}

// All line writes share the case lock and transaction; publish one revision only
// after every line and its audit events have succeeded.
function specialBatchLines(input, kinds) {
  const lines = input?.lines;
  if (!Array.isArray(lines) || !lines.length || lines.length > 100
    || lines.some(line => !line || !Number.isSafeInteger(Number(line.lineId)) || Number(line.lineId) <= 0
      || (kinds && !kinds.includes(line.kind)))
    || new Set(lines.map(line => Number(line.lineId))).size !== lines.length) {
    throw workflowError('Submit 1 to 100 distinct case lines.', 400, 'SPECIAL_BATCH_LINES_INVALID');
  }
  return lines;
}

export async function saveSpecialStockChecks(requestId, input = {}, context = {}) {
  const lines = specialBatchLines(input, ['response', 'readiness']);
  const id = positiveId(requestId, 'Special Item case');
  await withTransaction(async () => {
    for (const line of lines) {
      const write = line.kind === 'readiness' ? writeSpecialReadiness : writeSpecialSupplyResponse;
      await write(id, line.lineId, { ...line, expectedRevision: input.expectedRevision }, context);
    }
    await bumpCase(id);
  });
  return getSpecialStockCase(id, { audience: 'scm' });
}

export async function saveSpecialCustomerDecisions(requestId, input = {}, context = {}) {
  const lines = specialBatchLines(input);
  const id = positiveId(requestId, 'Special Item case');
  await withTransaction(async () => {
    for (const line of lines) await writeSpecialCustomerDecision(id, line.lineId, { ...line, expectedRevision: input.expectedRevision }, context);
    await bumpCase(id);
  });
  return getSpecialStockCase(id, { audience: 'sales', authorizedStoreLocationIds: context.authorizedStoreLocationIds || [] });
}

export async function saveSpecialSalesOrderDraft(requestId, input, {
  operatorId,
  authorizedStoreLocationIds = []
} = {}) {
  const id = positiveId(requestId, "Special Item case");
  await withTransaction(async () => {
    const special = await lockCase(id, input.expectedRevision);
    assertScope(mapCase(special), authorizedStoreLocationIds);
    assertCaseEditable(special);
    const draft = /** @type {ReturnType<typeof normalizeSpecialSalesOrderDraft>&Record<string,any>} */ (normalizeSpecialSalesOrderDraft({ ...input,
      deliveryFeeRate: input.deliveryFeeRate === undefined ? special.delivery_fee_rate : input.deliveryFeeRate }));
    if (special.sales_order_netsuite_id || special.purchase_order_netsuite_id || special.sales_order_skipped || special.purchase_order_skipped || special.close_status !== "active") {
      throw workflowError("The Sales Order draft is locked after an order is linked or closure starts.", 409, "SPECIAL_SO_DRAFT_LOCKED");
    }
    if (!new Set((authorizedStoreLocationIds || []).map(Number)).has(draft.operationalYardLocationId)) {
      throw workflowError("The operational yard is outside your Sales yard access.", 403, "SPECIAL_CASE_STORE_FORBIDDEN");
    }
    const customer = await findSpecialCustomer(draft.customerId);
    if (!customer) throw workflowError('Select an active NetSuite customer.',409,'SPECIAL_SO_CUSTOMER_INVALID');
    const rows = await lineRows(id, { forUpdate: true });
    const mapped = rows.map(mapLine);
    if (draft.fulfillmentMethod === 'yard_pickup' && draft.operationalYardLocationId !== Number(special.destination_location_id)) {
      throw workflowError('Customer yard pickup must use the inquired yard.', 409, 'SPECIAL_PICKUP_YARD_MISMATCH');
    }
    const release = assertSpecialOrderRelease(mapped, { requireMapping: false });
    const acceptedById = new Map(release.acceptedLines.map((line) => [line.id, line]));
    if (draft.materialLines.length !== acceptedById.size
        || draft.materialLines.some((line) => !acceptedById.has(line.caseLineId))) {
      throw workflowError("The Sales Order must include every accepted case line exactly once.", 409, "SPECIAL_SO_ACCEPTED_LINES_MISMATCH");
    }
    draft.materialLines = draft.materialLines.map(line => prepareSpecialMaterial(line, acceptedById.get(line.caseLineId)));
    const quantityChanges = draftQuantityChanges(draft.materialLines, acceptedById);
    const quantityReview = quantityChanges.length ? newQuantityReview(quantityChanges, 'draft', operatorId)
      : special.quantity_review?.mode === 'draft' && quantityReviewPending(special.quantity_review) ? {} : special.quantity_review;
    for (const line of draft.materialLines) {
      const accepted = acceptedById.get(line.caseLineId);
      const item = await query('SELECT item_name FROM inventory_items WHERE item_id=2055 FOR SHARE');
      if (!item.rowCount) throw workflowError('MBBS-Special Order is missing from the synced item master.', 409, 'SPECIAL_SO_ITEM_NOT_FOUND');
      accepted.itemResolution = { itemId: 2055, itemName: item.rows[0].item_name, description: line.description,
        salesQuantity: line.quantity, salesUom: line.uom, purchaseQuantity: line.quantity, purchaseUom: line.uom };
      await query(`UPDATE sales_special_stock_lines SET resolved_item_id=2055, resolved_item_name=$3,
        resolved_description=$4, sales_quantity=$5, sales_uom=$6, purchase_quantity=$5, purchase_uom=$6,
        po_ready=false, po_ready_at=NULL, po_ready_response_revision=NULL,
        quoted_discount_percent=CASE WHEN original_unit_rate IS NULL THEN $9 ELSE quoted_discount_percent END,
        pricing_source=CASE WHEN original_unit_rate IS NULL THEN 'legacy_entry' ELSE pricing_source END,
        original_unit_rate=COALESCE(original_unit_rate,$7), original_rate_uom=COALESCE(original_rate_uom,$8),
        discount_percent=$9, sales_package_quantity=$10, pieces_per_unit=$11,
        scm_reviewed_pieces_per_unit=COALESCE(scm_reviewed_pieces_per_unit,$11)
        WHERE request_id=$1 AND id=$2`,
      [id, line.caseLineId, item.rows[0].item_name, line.description, line.quantity, line.uom,
        line.originalRate,line.basisUom,line.discountPercent,line.packageQuantity,line.conversionToPc]);
    }
    const mediaIds = draft.media.map((media) => media.id);
    if (mediaIds.length) {
      const media = await query(
        `SELECT upload_id, mime_type, byte_size, status
           FROM sales_special_stock_media
          WHERE request_id = $1 AND upload_id = ANY($2::uuid[])
          FOR UPDATE`,
        [id, mediaIds]
      );
      if (media.rowCount !== mediaIds.length
          || media.rows.some((row) => row.status !== "staged")
          || media.rows.some((row) => !draft.media.some((inputMedia) => inputMedia.id === row.upload_id
            && inputMedia.mimeType === row.mime_type && inputMedia.byteSize === Number(row.byte_size)))) {
        throw workflowError("One or more delivery media uploads are not staged for this case.", 409, "SPECIAL_SO_MEDIA_NOT_STAGED");
      }
    }
    await query("DELETE FROM sales_special_stock_order_lines WHERE request_id = $1", [id]);
    for (const line of draft.materialLines) {
      const accepted = acceptedById.get(line.caseLineId);
      await query(
        `INSERT INTO sales_special_stock_order_lines (
           request_id, case_line_id, order_kind, ancillary, item_id, item_name,
           description, quantity, uom, unit_rate, unit_purchase_cost, native_discount_percent,
           pack_pallet_qty, pack_layer_qty, pack_section_qty, pack_piece_qty
         ) VALUES ($1,$2,'sales_order',false,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id, line.caseLineId, line.itemId, accepted.itemResolution.itemName,
          line.description || accepted.itemResolution.description, line.quantity, line.uom,
          line.rate, accepted.unitPurchaseCost, line.discountPercent,
          accepted.palletQty, accepted.layerQty, accepted.sectionQty, accepted.pieceQty
        ]
      );
      await query(
        `INSERT INTO sales_special_stock_order_lines (
           request_id, case_line_id, order_kind, ancillary, item_id, item_name,
           description, quantity, uom, unit_purchase_cost
         ) VALUES ($1,$2,'purchase_order',false,$3,$4,$5,$6,$7,$8)`,
        [
          id, line.caseLineId, line.itemId, accepted.itemResolution.itemName,
          line.description || accepted.itemResolution.description,
          accepted.itemResolution.purchaseQuantity || accepted.itemResolution.salesQuantity,
          accepted.itemResolution.purchaseUom, accepted.unitPurchaseCost
        ]
      );
    }
    for (const line of draft.ancillaryLines) {
      const item = await query("SELECT item_name FROM inventory_items WHERE item_id = $1 FOR SHARE", [line.itemId]);
      if (!item.rowCount) throw workflowError("An ancillary NetSuite item was not found.", 404, "SPECIAL_SO_ITEM_NOT_FOUND");
      await query(
        `INSERT INTO sales_special_stock_order_lines (
           request_id, order_kind, ancillary, item_id, item_name,
           description, quantity, uom, unit_rate
         ) VALUES ($1,'sales_order',true,$2,$3,$4,$5,$6,$7)`,
        [id, line.itemId, item.rows[0].item_name, line.description, line.quantity, line.uom, line.rate]
      );
    }
    await query(
      `UPDATE sales_special_stock_cases
          SET order_customer_netsuite_id = $2, operational_yard_location_id = $3,
              fulfillment_method = $4, delivery_address = $5,
              delivery_date = $6, delivery_window_start = $7, delivery_window_end = $8,
              delivery_instructions=$9, delivery_contact_name=$10, delivery_contact_phone=$11,
              pallet_total=$12, pallet_rate=$13, quantity_review=$14::jsonb, order_customer_name=$15, delivery_fee_rate=$16, vendor_discount_review='{}', line_edit_state='{}', updated_at=now()
        WHERE request_id = $1`,
      [
        id, customer.id, draft.operationalYardLocationId, draft.fulfillmentMethod,
        draft.deliveryAddress, draft.deliveryDate, draft.windowStart, draft.windowEnd,
        draft.deliveryInstructions, draft.deliveryContactName, draft.deliveryContactPhone, draft.palletTotal, draft.palletRate, JSON.stringify(quantityReview || {}), customer.name, draft.deliveryFeeRate
      ]
    );
    if (input.netsuiteSalesRep) await query('UPDATE sales_special_stock_cases SET netsuite_sales_rep_id=$2,netsuite_sales_rep_name=$3 WHERE request_id=$1',
      [id, positiveId(input.netsuiteSalesRep.id,'NetSuite Sales Rep'),cleanSearch(input.netsuiteSalesRep.name,500)]);
    await bumpCase(id);
    if (quantityChanges.length) await appendEvent(id, 'special_quantity_review_requested', operatorId, { reviewId: quantityReview.id, mode: 'draft', lines: quantityChanges });
    await appendEvent(id, "special_sales_order_draft_saved", operatorId, {
      customerId: draft.customerId,
      fulfillmentMethod: draft.fulfillmentMethod,
      operationalYardLocationId: draft.operationalYardLocationId,
      materialLineCount: draft.materialLines.length,
      ancillaryLineCount: draft.ancillaryLines.length,
      mediaCount: draft.media.length
    });
  });
  return getSpecialStockCase(id, { audience: "sales", authorizedStoreLocationIds });
}

async function upsertHandoff(requestId, special) {
  if (['applying','attention'].includes(special.fulfillment_change?.status)) return;
  if (special.purchase_order_netsuite_id && !(await query('SELECT approved FROM special_stock_purchase_approval WHERE request_id=$1',[requestId])).rows[0]?.approved) return;
  if (quantityReviewPending(special.quantity_review)) return;
  if (special.sales_order_skipped || special.purchase_order_skipped) return;
  if (!special.purchase_order_netsuite_id || !special.sales_order_netsuite_id) return;
  if (special.fulfillment_method === "vendor_pickup") {
    await query("DELETE FROM sales_special_stock_handoffs WHERE request_id = $1", [requestId]);
    await query("UPDATE sales_special_stock_cases SET handoff_route = 'none' WHERE request_id = $1", [requestId]);
    return;
  }
  const readiness = await lineRows(requestId);
  if (readiness.some(row => row.sales_decision === 'accepted' && !specialStockAvailable(row.supply_status))) return;
  const lineResult = await query(
    `SELECT id, line_number, product_name, requested_quantity, requested_uom,
            resolved_item_id, resolved_description, sales_quantity, sales_uom
       FROM sales_special_stock_lines
      WHERE request_id = $1 AND sales_decision = 'accepted'
      ORDER BY line_number`,
    [requestId]
  );
  const yard = YARD_NAMES.get(Number(special.operational_yard_location_id)) || String(special.operational_yard_location_id);
  const destination = special.fulfillment_method === "mbt_delivery"
    ? special.delivery_address
    : yard;
  const vendorYard = await query(
    `SELECT vendor_yard FROM sales_special_stock_lines
      WHERE request_id = $1 AND sales_decision = 'accepted'
      ORDER BY line_number LIMIT 1`,
    [requestId]
  );
  await query(
    `INSERT INTO sales_special_stock_handoffs (
       request_id, route, status, sales_order_netsuite_id, purchase_order_netsuite_id,
       pickup_address, destination_address, operational_yard_location_id,
       line_snapshot, route_selected_by, route_selected_at
     ) VALUES ($1,NULL,'waiting_route',$2,$3,$4,$5,$6,$7::jsonb,NULL,NULL)
     ON CONFLICT (request_id) DO UPDATE
       SET sales_order_netsuite_id = EXCLUDED.sales_order_netsuite_id,
           purchase_order_netsuite_id = EXCLUDED.purchase_order_netsuite_id,
           pickup_address = EXCLUDED.pickup_address,
           destination_address = EXCLUDED.destination_address,
           operational_yard_location_id = EXCLUDED.operational_yard_location_id,
           line_snapshot = EXCLUDED.line_snapshot,
           status = CASE
             WHEN sales_special_stock_handoffs.status IN ('planned', 'in_progress', 'completed')
               THEN sales_special_stock_handoffs.status
             ELSE 'waiting_route'
           END,
           updated_at = now()`,
    [
      requestId, special.sales_order_netsuite_id, special.purchase_order_netsuite_id,
      vendorYard.rows[0]?.vendor_yard || "Vendor yard unavailable",
      destination, special.operational_yard_location_id,
      JSON.stringify(lineResult.rows)
    ]
  );
}

async function materializeSpecialDeliveryInstructions(requestId) {
  const specialResult = await query(
    `SELECT sales_order_netsuite_id, fulfillment_method, delivery_address,
            delivery_date, delivery_window_start, delivery_window_end,
            delivery_instructions, delivery_contact_name, delivery_contact_phone
       FROM sales_special_stock_cases
      WHERE request_id = $1`,
    [requestId]
  );
  const special = specialResult.rows[0];
  if (!special?.sales_order_netsuite_id) return false;
  const instructions = [special.delivery_instructions,
    special.delivery_contact_name || special.delivery_contact_phone
      ? `Contact: ${special.delivery_contact_name || ''} ${special.delivery_contact_phone || ''}` : null
  ].filter(Boolean).join('\n');
  const canonical = await query(
    "SELECT netsuite_id FROM sales_orders WHERE netsuite_id = $1 FOR SHARE",
    [special.sales_order_netsuite_id]
  );
  if (!canonical.rowCount) return false;
  if (special.fulfillment_method === "mbt_delivery") {
    await query(
      `UPDATE sales_orders
          SET expected_delivery_date = $2,
              dispatch_address = $3,
              dispatch_window_start = $4,
              dispatch_window_end = $5,
              dispatch_instructions = $6,
              dispatch_parse_source = 'manual-dispatch-details',
              dispatch_parsed_at = now()
        WHERE netsuite_id = $1`,
      [
        special.sales_order_netsuite_id,
        special.delivery_date,
        special.delivery_address,
        timeValue(special.delivery_window_start),
        timeValue(special.delivery_window_end),
        instructions
      ]
    );
  }
  await query(
    `INSERT INTO sales_order_delivery_instructions (
       sales_order_id, additional_text, revision,
       created_by, created_source, updated_by, updated_source
     ) VALUES ($1,$2,1,NULL,'sales',NULL,'sales')
     ON CONFLICT (sales_order_id) DO NOTHING`,
    [special.sales_order_netsuite_id, instructions]
  );
  const revisionResult = await query(
    "SELECT revision FROM sales_order_delivery_instructions WHERE sales_order_id = $1",
    [special.sales_order_netsuite_id]
  );
  const revision = Number(revisionResult.rows[0]?.revision) || 1;
  const positionResult = await query(
    `SELECT COALESCE(MAX(position), 0)::int AS position
       FROM sales_order_delivery_instruction_media
      WHERE sales_order_id = $1 AND deleted_at IS NULL`,
    [special.sales_order_netsuite_id]
  );
  let position = Number(positionResult.rows[0]?.position) || 0;
  const media = await query(
    `SELECT upload_id, object_ref, mime_type, byte_size, created_by
       FROM sales_special_stock_media
      WHERE request_id = $1 AND status IN ('staged', 'attached')
        AND object_ref IS NOT NULL
      ORDER BY created_at, upload_id`,
    [requestId]
  );
  for (const item of media.rows) {
    position += 1;
    await query(
      `INSERT INTO sales_order_delivery_instruction_media (
         id, sales_order_id, object_reference, media_kind, mime_type,
         original_file_name, byte_size, position, instruction_revision,
         uploaded_by, uploaded_source
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sales')
       ON CONFLICT (id) DO NOTHING`,
      [
        item.upload_id, special.sales_order_netsuite_id, item.object_ref,
        String(item.mime_type).startsWith("video/") ? "video" : "image",
        item.mime_type, `special-${item.upload_id}`, item.byte_size,
        position, revision, item.created_by
      ]
    );
  }
  await query(
    `UPDATE sales_special_stock_media
        SET status = 'attached', attached_sales_order_id = $2,
            attached_at = COALESCE(attached_at, now())
      WHERE request_id = $1 AND status IN ('staged', 'attached')`,
    [requestId, special.sales_order_netsuite_id]
  );
  return true;
}

/** @param {Record<string,any>} special */
function assertNoSpecialLineDecisionReview(special) {
  if (special.line_edit_state?.orderReviewRequired === true) throw workflowError(
    'Save the SO draft after changing line decisions before creating or linking an order.', 409, 'SPECIAL_DECISION_REVIEW_REQUIRED');
}

export async function linkSpecialSalesOrder(requestId, {
  expectedRevision: revision,
  salesOrderId,
  salesOrderRef,
  source = "manual_link",
  salesOrderStatus = null,
  salesOrderApproved = false,
  operationId = null,
  verifiedRemote = false
} = {}, { operatorId, authorizedStoreLocationIds = undefined } = {}) {
  const id = positiveId(requestId, "Special Item case");
  const remoteId = positiveId(salesOrderId, "Sales Order");
  const remoteRef = cleanSearch(salesOrderRef, 120);
  let resolvedSalesOrderStatus = salesOrderStatus;
  let resolvedSalesOrderApproved = salesOrderApproved === true;
  if (!remoteRef) throw workflowError("Sales Order number is required.");
  await withTransaction(async () => {
    const special = await lockCase(id, revision);
    assertNoSpecialQuantityReview(special);
    assertNoSpecialLineDecisionReview(special);
    assertScope(mapCase(special), authorizedStoreLocationIds);
    assertSpecialStockRemoteOrderAllowed(mapCase(special));
    if (!verifiedRemote) assertCaseEditable(special);
    if (special.sales_order_netsuite_id && Number(special.sales_order_netsuite_id) !== remoteId) throw workflowError('This request already owns an SO.', 409, 'SPECIAL_SO_ALREADY_LINKED');
    assertSpecialOrderRelease((await lineRows(id)).map(mapLine));
    if (special.pallet_total == null) throw workflowError('Save the SO draft including pallet count before linking.', 409, 'SPECIAL_SO_DRAFT_REQUIRED');
    if (special.purchase_order_netsuite_id || special.close_status !== "active") {
      throw workflowError("The Sales Order cannot be changed after PO creation or closure.", 409, "SPECIAL_SO_LINK_LOCKED");
    }
    let reconciliationError = null;
    if (!verifiedRemote) {
      const canonical = await query(
        `SELECT netsuite_id, tranid, customer_id, order_location_id,
                netsuite_active, status, status_text
           FROM sales_orders WHERE netsuite_id = $1 FOR SHARE`,
        [remoteId]
      );
      const order = canonical.rows[0];
      if (!order) throw workflowError("Sales Order was not found in the local NetSuite mirror.", 404, "SPECIAL_SO_NOT_FOUND");
      if (order.netsuite_active !== true || /closed|cancel/i.test(`${order.status || ""} ${order.status_text || ""}`)) {
        throw workflowError("The linked Sales Order is not active.", 409, "SPECIAL_SO_INACTIVE");
      }
      if ((special.order_customer_netsuite_id || special.canonical_customer_id || special.directory_customer_id) && Number(order.customer_id) !== Number(special.order_customer_netsuite_id || special.canonical_customer_id || special.directory_customer_id)) {
        throw workflowError("The Sales Order belongs to a different customer.", 409, "SPECIAL_SO_CUSTOMER_MISMATCH");
      }
      if (String(order.tranid || "").trim().toLowerCase() !== remoteRef.toLowerCase()) {
        throw workflowError("The Sales Order number does not match its NetSuite internal ID.", 409, "SPECIAL_SO_REFERENCE_MISMATCH");
      }
      if (special.operational_yard_location_id && order.order_location_id
          && Number(order.order_location_id) !== Number(special.operational_yard_location_id)) {
        throw workflowError("The Sales Order uses a different operational yard.", 409, "SPECIAL_SO_YARD_MISMATCH");
      }
      resolvedSalesOrderStatus = order.status_text || order.status || null;
      resolvedSalesOrderApproved = order.netsuite_active === true
        && !/pending approval|closed|cancel/i.test(`${order.status || ""} ${order.status_text || ""}`)
        && Boolean(`${order.status || ""} ${order.status_text || ""}`.trim());
      await reconcileCanonicalOrderLines(id, "sales_order", remoteId, { required: true });
    }
    try {
      await query(
        `UPDATE sales_special_stock_cases
            SET sales_order_source = $2, sales_order_netsuite_id = $3,
                sales_order_ref = $4, sales_order_status = $5,
                sales_order_approved = $6, sales_order_operation_status = 'linked',
                sales_order_operation_id = COALESCE($7, sales_order_operation_id),
                sales_order_operation_error = NULL, attention = false,
                attention_reason = NULL, updated_at = now()
          WHERE request_id = $1`,
        [id, source, remoteId, remoteRef, resolvedSalesOrderStatus, resolvedSalesOrderApproved, operationId]
      );
    } catch (error) {
      if (error?.code === "23505") throw workflowError("This Sales Order is already owned by another Special Item case.", 409, "SPECIAL_SO_ALREADY_LINKED");
      throw error;
    }
    if (verifiedRemote) {
      try {
        await reconcileCanonicalOrderLines(id, "sales_order", remoteId);
      } catch (error) {
        reconciliationError = error;
        await query(
          `UPDATE sales_special_stock_cases
              SET attention = true, attention_reason = $2, updated_at = now()
            WHERE request_id = $1`,
          [id, cleanSearch(error.message, 2_000)]
        );
        await appendEvent(id, "special_sales_order_line_reconciliation_attention", operatorId, {
          salesOrderId: remoteId,
          error: error.message
        });
      }
    }
    await materializeSpecialDeliveryInstructions(id);
    await bumpCase(id);
    await appendEvent(id, "special_sales_order_linked", operatorId, {
      salesOrderId: remoteId,
      salesOrderRef: remoteRef,
      source,
      approved: resolvedSalesOrderApproved,
      lineReconciliation: reconciliationError ? "attention" : "matched_or_waiting_sync"
    });
  });
  return getSpecialStockCase(id, { audience: "sales", authorizedStoreLocationIds });
}

export async function setSpecialSalesOrderStatus(requestId, {
  salesOrderStatus,
  approved,
  active = true,
  salesOrderRef = null
} = {}, { operatorId = null } = {}) {
  const id = positiveId(requestId, "Special Item case");
  await withTransaction(async () => {
    const special = await selectCaseRow(id, { forUpdate: true });
    assertSpecialStockRemoteOrderAllowed(mapCase(special));
    if (!special.sales_order_netsuite_id) throw workflowError("This case has no linked Sales Order.", 409, "SPECIAL_SO_NOT_LINKED");
    const closed = active === false || /closed|cancel/i.test(String(salesOrderStatus || ""));
    await query(
      `UPDATE sales_special_stock_cases
          SET sales_order_status = $2,
              sales_order_ref = COALESCE(NULLIF($3, ''), sales_order_ref),
              sales_order_approved = $4,
              close_status = CASE WHEN close_status = 'closure_pending' AND purchase_order_netsuite_id IS NULL AND COALESCE(closure_review->>'id','') = '' AND $5 THEN 'closed' ELSE close_status END,
              closed_at = CASE WHEN close_status = 'closure_pending' AND purchase_order_netsuite_id IS NULL AND COALESCE(closure_review->>'id','') = '' AND $5 THEN now() ELSE closed_at END,
              updated_at = now()
        WHERE request_id = $1`,
      [id, salesOrderStatus || null, cleanSearch(salesOrderRef, 120), approved === true, closed]
    );
    if (closed && special.close_status === "closure_pending" && !special.purchase_order_netsuite_id && !special.closure_review?.id) {
      await query("UPDATE sales_stock_requests SET status = 'cancelled' WHERE id = $1", [id]);
    }
    await materializeSpecialDeliveryInstructions(id);
    await bumpCase(id);
    await appendEvent(id, "special_sales_order_status_reconciled", operatorId, { salesOrderStatus, approved: approved === true, active: active !== false });
  });
  return getSpecialStockCase(id, { audience: "scm" });
}

export async function reconcileSpecialOrderWebhook({ orderKind, orderId } = {}) {
  const normalizedKind = orderKind === "sales_order" || orderKind === "purchase_order" ? orderKind : null;
  const remoteId = Number(orderId);
  if (!normalizedKind || !Number.isSafeInteger(remoteId) || remoteId <= 0) return { matched: false };
  return withTransaction(async () => {
    const match = await query(
      `SELECT request_id
         FROM sales_special_stock_cases
        WHERE ${normalizedKind === "sales_order" ? "sales_order_netsuite_id" : "purchase_order_netsuite_id"} = $1
        FOR UPDATE`,
      [remoteId]
    );
    if (!match.rowCount) return { matched: false };
    const requestId = Number(match.rows[0].request_id);
    let special = await selectCaseRow(requestId, { forUpdate: true });
    const salesStatus = special.canonical_sales_status_text || special.canonical_sales_status || special.sales_order_status || null;
    const purchaseStatus = special.canonical_purchase_status_text || special.canonical_purchase_status || special.purchase_order_status || null;
    const salesStatusText = `${special.canonical_sales_status || ""} ${special.canonical_sales_status_text || ""}`.trim();
    const approved = special.canonical_sales_active !== false
      && Boolean(salesStatusText)
      && !/pending approval|closed|cancel/i.test(salesStatusText);
    /** @type {any} */
    let lineError = null;
    try {
      if (special.sales_order_netsuite_id && (!special.purchase_order_custom_linkage || normalizedKind === 'sales_order')) {
        const pending = !special.purchase_order_netsuite_id && ['creating', 'attention'].includes(special.purchase_order_operation_status)
          ? (await query(`SELECT so.id AS expected_line_id,so.remote_line_id,po.description,po.quantity,po.uom
              FROM sales_special_stock_order_lines so JOIN sales_special_stock_order_lines po
                ON po.request_id=so.request_id AND po.case_line_id=so.case_line_id AND po.order_kind='purchase_order'
              WHERE so.request_id=$1 AND so.order_kind='sales_order' AND so.item_id=2055 AND po.item_id=2055
                AND so.remote_line_id IS NOT NULL
                AND (so.description,so.quantity,so.uom) IS DISTINCT FROM (po.description,po.quantity,po.uom)`, [requestId])).rows : [];
        await reconcileCanonicalOrderLines(requestId, "sales_order", special.sales_order_netsuite_id, {
          quantityReview: special.quantity_review,
          reviewedDescriptionChanges: pending.map(row => ({ expectedLineId: Number(row.expected_line_id), remoteLineId: Number(row.remote_line_id), description: row.description, quantity: Number(row.quantity), uom: row.uom }))
        });
      }
      if (special.purchase_order_netsuite_id) {
        await reconcileCanonicalOrderLines(requestId, "purchase_order", special.purchase_order_netsuite_id, { quantityReview: special.quantity_review });
      }
    } catch (error) {
      lineError = error;
    }
    special = await selectCaseRow(requestId, { forUpdate: true });
    const reconciled = Boolean(terminalSalesOrder(special) && terminalPurchaseOrder(special));
    const preserveSalesAttention = special.purchase_order_custom_linkage && normalizedKind === 'purchase_order'
      && /^Sales Order\b/.test(special.attention_reason || '');
    await query(
      `UPDATE sales_special_stock_cases
          SET sales_order_status = $2,
              sales_order_approved = $3,
              purchase_order_status = $4,
              remotely_reconciled = remotely_reconciled OR $5,
              remotely_reconciled_at = CASE
                WHEN remotely_reconciled OR $5 THEN COALESCE(remotely_reconciled_at, now())
                ELSE remotely_reconciled_at
              END,
              attention = CASE
                WHEN $6::text IS NOT NULL THEN true
                WHEN $7::boolean THEN attention
                WHEN sales_order_operation_status <> 'attention'
                 AND purchase_order_operation_status <> 'attention' THEN false
                ELSE attention
              END,
              attention_reason = CASE
                WHEN $6::text IS NOT NULL THEN $6
                WHEN $7::boolean THEN attention_reason
                WHEN sales_order_operation_status <> 'attention'
                 AND purchase_order_operation_status <> 'attention' THEN NULL
                ELSE attention_reason
              END,
              updated_at = now()
        WHERE request_id = $1`,
      [requestId, salesStatus, approved, purchaseStatus, reconciled, lineError ? cleanSearch(lineError.message, 2_000) : null, Boolean(preserveSalesAttention)]
    );
    special = await selectCaseRow(requestId, { forUpdate: true });
    if (!lineError && (!special.purchase_order_custom_linkage || !special.attention) && await canonicalLinksReady(requestId)) await upsertHandoff(requestId, special);
    await materializeSpecialDeliveryInstructions(requestId);
    await bumpCase(requestId);
    await appendEvent(requestId, lineError ? "special_order_line_reconciliation_attention" : "special_order_webhook_reconciled", null, {
      orderKind: normalizedKind,
      orderId: remoteId,
      salesOrderApproved: approved,
      remotelyReconciled: reconciled,
      error: lineError?.message || null
    });
    return { matched: true, requestId, attention: Boolean(lineError || preserveSalesAttention && special.attention), remotelyReconciled: reconciled };
  });
}

export async function linkSpecialPurchaseOrder(requestId, {
  expectedRevision: revision,
  purchaseOrderId,
  purchaseOrderRef,
  purchaseOrderStatus = null,
  operationId = null,
  verifiedRemote = false,
  customLinkage = false
} = {}, { operatorId } = {}) {
  const id = positiveId(requestId, "Special Item case");
  const custom = customLinkage === true && !verifiedRemote;
  let remoteId = custom ? null : positiveId(purchaseOrderId, "Purchase Order");
  let remoteRef = cleanSearch(purchaseOrderRef, 120);
  let resolvedPurchaseOrderStatus = purchaseOrderStatus;
  if (!remoteRef) throw workflowError("Purchase Order number is required.");
  await withTransaction(async () => {
    const special = verifiedRemote
      ? await lockOwnedOrderOperation(id, revision, 'purchase_order', operationId)
      : await lockCase(id, revision);
    assertNoSpecialQuantityReview(special);
    assertSpecialStockRemoteOrderAllowed(mapCase(special));
    if (!verifiedRemote) assertCaseEditable(special);
    if (!custom && special.purchase_order_netsuite_id && Number(special.purchase_order_netsuite_id) !== remoteId) throw workflowError('This request already owns a PO.', 409, 'SPECIAL_PO_ALREADY_LINKED');
    const unsynced = !custom && await query(`SELECT 1 FROM sales_special_stock_order_lines so
      JOIN sales_special_stock_order_lines po ON po.request_id=so.request_id AND po.case_line_id=so.case_line_id AND po.order_kind='purchase_order'
      WHERE so.request_id=$1 AND so.order_kind='sales_order' AND so.description IS DISTINCT FROM po.description LIMIT 1`, [id]);
    if (unsynced && unsynced.rowCount) throw workflowError('Synchronize the SO descriptions before linking a PO.', 409, 'SPECIAL_SO_DESCRIPTION_NOT_SYNCED');
    if (!special.sales_order_netsuite_id || special.sales_order_approved !== true) {
      throw workflowError("The linked Sales Order must be approved and active before PO creation.", 409, "SPECIAL_PO_SO_NOT_APPROVED");
    }
    if (special.canonical_sales_dispatch_planned === true) {
      throw workflowError("Unplan the Sales Order before attaching a Special Item Purchase Order.", 409, "SPECIAL_PO_SO_ALREADY_PLANNED");
    }
    (custom ? assertSpecialOrderRelease : assertSpecialPurchaseRelease)((await lineRows(id, { forUpdate: true })).map(mapLine));
    if (special.close_status !== "active") throw workflowError("A closing case cannot link a Purchase Order.", 409, "SPECIAL_CASE_CLOSED");
    let reconciliationError = null;
    if (!verifiedRemote) {
      const canonical = await query(
        `SELECT netsuite_id, tranid, vendor_id, destination_location_id,
                netsuite_active, status, status_text
           FROM purchase_orders
          WHERE ($2::boolean AND lower(tranid)=lower($3)) OR (NOT $2::boolean AND netsuite_id=$1)
          ORDER BY netsuite_id FOR SHARE`,
        [remoteId, custom, remoteRef]
      );
      if (canonical.rowCount > 1) throw workflowError('More than one PO has this number. Verify the PO number before linking.', 409, 'SPECIAL_PO_REFERENCE_AMBIGUOUS');
      const order = canonical.rows[0];
      if (!order) throw workflowError("Purchase Order was not found in the local NetSuite mirror.", 404, "SPECIAL_PO_NOT_FOUND");
      if (custom) {
        remoteId = Number(order.netsuite_id);
        if (purchaseOrderId != null && Number(purchaseOrderId) !== remoteId) throw workflowError('The PO number does not match its NetSuite internal ID.', 409, 'SPECIAL_PO_REFERENCE_MISMATCH');
        remoteRef = order.tranid;
        if (special.purchase_order_netsuite_id && Number(special.purchase_order_netsuite_id) !== remoteId) throw workflowError('This request already owns a PO.', 409, 'SPECIAL_PO_ALREADY_LINKED');
      }
      if (order.netsuite_active === false || /closed|cancel/i.test(`${order.status || ""} ${order.status_text || ""}`)) {
        throw workflowError("The linked Purchase Order is not active.", 409, "SPECIAL_PO_INACTIVE");
      }
      if (special.vendor_id && Number(order.vendor_id) !== Number(special.vendor_id)) {
        throw workflowError("The Purchase Order belongs to a different vendor.", 409, "SPECIAL_PO_VENDOR_MISMATCH");
      }
      if (String(order.tranid || "").trim().toLowerCase() !== remoteRef.toLowerCase()) {
        throw workflowError("The Purchase Order number does not match its NetSuite internal ID.", 409, "SPECIAL_PO_REFERENCE_MISMATCH");
      }
      if (special.operational_yard_location_id && order.destination_location_id
          && Number(order.destination_location_id) !== Number(special.operational_yard_location_id)) {
        throw workflowError("The Purchase Order uses a different destination yard.", 409, "SPECIAL_PO_YARD_MISMATCH");
      }
      resolvedPurchaseOrderStatus = order.status_text || order.status || null;
      const allocated = await query(
        `SELECT id FROM dispatch_so_po_allocations
          WHERE po_order_id = $1 AND status = 'active'
          LIMIT 1 FOR SHARE`,
        [remoteId]
      );
      if (allocated.rowCount) {
        throw workflowError("The Purchase Order already has an active Dispatch allocation and is not exclusive to this case.", 409, "SPECIAL_PO_ALREADY_ALLOCATED");
      }
      if (!custom) {
        await reconcileCanonicalOrderLines(id, "sales_order", special.sales_order_netsuite_id, { required: true });
        await reconcileCanonicalOrderLines(id, "purchase_order", remoteId, { required: true });
      }
    }
    try {
      await query(
        `UPDATE sales_special_stock_cases
            SET purchase_order_netsuite_id = $2, purchase_order_ref = $3,
                purchase_order_status = $4, purchase_order_operation_status = 'linked',
                purchase_order_operation_id = COALESCE($5, purchase_order_operation_id),
                purchase_order_operation_error = NULL,
                purchase_order_custom_linkage = $6 OR purchase_order_custom_linkage,
                attention = CASE WHEN $6 THEN attention ELSE false END,
                attention_reason = CASE WHEN $6 THEN attention_reason ELSE NULL END, updated_at = now()
          WHERE request_id = $1`,
        [id, remoteId, remoteRef, resolvedPurchaseOrderStatus, operationId, custom]
      );
    } catch (error) {
      if (error?.code === "23505") throw workflowError("This Purchase Order is already owned by another Special Item case.", 409, "SPECIAL_PO_ALREADY_LINKED");
      throw error;
    }
    if (verifiedRemote) {
      try {
        await reconcileCanonicalOrderLines(id, "sales_order", special.sales_order_netsuite_id);
        await reconcileCanonicalOrderLines(id, "purchase_order", remoteId);
      } catch (error) {
        reconciliationError = error;
        await query(
          `UPDATE sales_special_stock_cases
              SET attention = true, attention_reason = $2, updated_at = now()
            WHERE request_id = $1`,
          [id, cleanSearch(error.message, 2_000)]
        );
        await appendEvent(id, "special_purchase_order_line_reconciliation_attention", operatorId, {
          purchaseOrderId: remoteId,
          error: error.message
        });
      }
    }
    const updated = await selectCaseRow(id, { forUpdate: true });
    const customLinesReady = !custom || await reconcileCanonicalOrderLines(id, 'purchase_order', remoteId, {required:true});
    if (!reconciliationError && customLinesReady && !updated.attention && await canonicalLinksReady(id)) await upsertHandoff(id, updated);
    await bumpCase(id);
    await appendEvent(id, "special_purchase_order_linked", operatorId, {
      purchaseOrderId: remoteId,
      purchaseOrderRef: remoteRef,
      customLinkage: custom,
      lineReconciliation: custom ? 'independent_of_sales_order' : reconciliationError ? "attention" : "matched_or_waiting_sync"
    });
  });
  return getSpecialStockCase(id, { audience: "scm" });
}

async function upgradeUnsubmittedDiscountDraft(requestId) {
  const rows=(await query(`SELECT orders.id,orders.quantity,orders.unit_rate,lines.original_unit_rate,lines.sales_package_quantity,lines.pieces_per_unit,lines.discount_percent
    FROM sales_special_stock_order_lines orders JOIN sales_special_stock_lines lines ON lines.id=orders.case_line_id
    WHERE orders.request_id=$1 AND orders.order_kind='sales_order' AND orders.native_discount_percent IS NULL AND lines.discount_percent>0
    FOR UPDATE OF orders`,[requestId])).rows;
  for(const row of rows){
    const input={quantity:row.sales_package_quantity,rate:row.original_unit_rate,conversionToPc:row.pieces_per_unit,discountPercent:row.discount_percent};
    const previous=specialNativePricing(input),next=specialNativeLinePricing(input);
    if(previous.quantity!==Number(row.quantity) || previous.rate!==Number(row.unit_rate))throw workflowError('Save the SO draft again to review its original pricing before creation.',409,'SPECIAL_RATE_LOCKED');
    await query('UPDATE sales_special_stock_order_lines SET unit_rate=$2,native_discount_percent=$3,updated_at=now() WHERE id=$1',[row.id,next.rate,next.discountPercent]);
  }
}

export async function claimSpecialOrderOperation(requestId, {
  expectedRevision: revision,
  orderKind,
  operationId = crypto.randomUUID(),
  netsuiteSalesRep = null
} = {}, { operatorId } = {}) {
  const id = positiveId(requestId, "Special Item case");
  const field = orderKind === "purchase_order" ? "purchase_order" : orderKind === "sales_order" ? "sales_order" : null;
  if (!field) throw workflowError("Select Sales Order or Purchase Order operation.");
  const operationUuid = String(operationId || "");
  if (!/^[0-9a-f-]{36}$/i.test(operationUuid)) throw workflowError("A valid operationId is required.");
  await withTransaction(async () => {
    const special = await lockCase(id, revision);
    assertNoSpecialQuantityReview(special);
    assertNoSpecialLineDecisionReview(special);
    if (['applying','attention'].includes(special.fulfillment_change?.status)) throw workflowError('Finish the saved delivery update first.',409,'SPECIAL_FULFILLMENT_PENDING');
    assertSpecialStockRemoteOrderAllowed(mapCase(special));
    if (special.close_status !== "active") {
      throw workflowError("A closing or closed case cannot start a remote order operation.", 409, "SPECIAL_CASE_CLOSED");
    }
    const status = special[`${field}_operation_status`];
    const existingOperationId = special[`${field}_operation_id`];
    if (status === "creating" || (status === "attention" && String(existingOperationId) !== operationUuid)) {
      throw workflowError("Another remote order operation is already running.", 409, "SPECIAL_REMOTE_OPERATION_BUSY");
    }
    if (field === "sales_order") {
      if (special.sales_order_netsuite_id) throw workflowError("A Sales Order is already linked.", 409, "SPECIAL_SO_ALREADY_LINKED");
      const count = await query("SELECT count(*)::int AS count FROM sales_special_stock_order_lines WHERE request_id = $1 AND order_kind = 'sales_order'", [id]);
      if (!Number(count.rows[0]?.count)) throw workflowError("Save the Sales Order draft first.", 409, "SPECIAL_SO_DRAFT_REQUIRED");
      if(!special.sales_order_submission_started_at) {
        await upgradeUnsubmittedDiscountDraft(id);
        if (netsuiteSalesRep) await query("UPDATE sales_special_stock_cases SET netsuite_sales_rep_id=$2,netsuite_sales_rep_name=$3,sales_discount_mode='total' WHERE request_id=$1",
          [id,positiveId(netsuiteSalesRep.id,'NetSuite Sales Rep'),cleanSearch(netsuiteSalesRep.name,500)]);
      }
    } else {
      if (special.purchase_order_netsuite_id) throw workflowError("A Purchase Order is already linked.", 409, "SPECIAL_PO_ALREADY_LINKED");
      if (!special.sales_order_netsuite_id || special.sales_order_approved !== true) {
        throw workflowError("The Sales Order must be approved before PO creation.", 409, "SPECIAL_PO_SO_NOT_APPROVED");
      }
      if (special.canonical_sales_dispatch_planned === true) {
        throw workflowError("Unplan the Sales Order before creating its Special Item Purchase Order.", 409, "SPECIAL_PO_SO_ALREADY_PLANNED");
      }
      assertSpecialPurchaseRelease((await lineRows(id, { forUpdate: true })).map(mapLine));
    }
    await query(
      `UPDATE sales_special_stock_cases
          SET ${field}_operation_status = 'creating',
              ${field}_operation_id = $2,
              ${field}_operation_error = NULL,
              updated_at = now()
        WHERE request_id = $1`,
      [id, operationUuid]
    );
    await bumpCase(id);
    await appendEvent(id, `special_${field}_operation_started`, operatorId, { operationId: operationUuid });
  });
  return getSpecialStockCase(id, { audience: "scm" });
}

export async function failSpecialOrderOperation(requestId, {
  orderKind,
  operationId,
  errorMessage,
  errorCode
} = {}, { operatorId = null } = {}) {
  const id = positiveId(requestId, "Special Item case");
  const field = orderKind === "purchase_order" ? "purchase_order" : "sales_order";
  await withTransaction(async () => {
    const special = await selectCaseRow(id, { forUpdate: true });
    if (String(special[`${field}_operation_id`] || "") !== String(operationId || "")) return;
    const message = cleanSearch(errorMessage, 2_000) || "Remote order operation failed.";
    if (field === 'sales_order' && errorCode === 'SPECIAL_DELIVERY_DATE_TOO_SOON' && !special.sales_order_submission_started_at) {
      await query(`UPDATE sales_special_stock_cases SET sales_order_operation_status='idle',sales_order_operation_id=NULL,
        sales_order_operation_error=NULL,updated_at=now() WHERE request_id=$1`,[id]);
      await bumpCase(id);
      await appendEvent(id,'special_sales_order_date_rejected',operatorId,{operationId,error:message});
      return;
    }
    await query(
      `UPDATE sales_special_stock_cases
          SET ${field}_operation_status = 'attention',
              ${field}_operation_error = $2,
              attention = true, attention_reason = $2, updated_at = now()
        WHERE request_id = $1`,
      [id, message]
    );
    await bumpCase(id);
    await appendEvent(id, `special_${field}_operation_attention`, operatorId, { operationId, error: message });
  });
  return getSpecialStockCase(id, { audience: "scm" });
}

async function assertPurchaseApproved(special) {
  if (!special.purchase_order_netsuite_id || !(await query('SELECT approved FROM special_stock_purchase_approval WHERE request_id=$1',[special.request_id])).rows[0]?.approved) {
    throw workflowError('The Purchase Order must be approved in NetSuite before continuing.',409,'SPECIAL_PO_APPROVAL_REQUIRED');
  }
}

export async function chooseSpecialHandoffRoute(requestId, {
  expectedRevision: revision,
  requestedRoute
} = {}, { operatorId } = {}) {
  const id = positiveId(requestId, "Special Item case");
  await withTransaction(async () => {
    const special = await lockCase(id, revision);
    assertNoSpecialQuantityReview(special);
    if (!special.purchase_order_netsuite_id || !special.sales_order_netsuite_id) {
      throw workflowError("Both SO and PO must be linked before route selection.", 409, "SPECIAL_ROUTE_ORDERS_REQUIRED");
    }
    if (special.post_po_change_pending === true || special.attention === true) {
      throw workflowError("Resolve the case Attention state before selecting a Dispatch route.", 409, "SPECIAL_ROUTE_ATTENTION");
    }
    await assertPurchaseApproved(special);
    assertCaseEditable(special);
    const readyRows = await lineRows(id, { forUpdate: true });
    assertStockReady(readyRows);
    assertSpecialOrderRelease(readyRows.map(mapLine));
    if (!await canonicalLinksReady(id)) {
      throw workflowError("Wait for exact SO and PO lines to synchronize before selecting a route.", 409, "SPECIAL_ROUTE_LINES_NOT_READY");
    }
    const normalized = normalizeSpecialHandoffRoute({
      fulfillmentMethod: special.fulfillment_method,
      requestedRoute
    });
    if (!normalized.required) throw workflowError("Vendor pickup does not create a Dispatch handoff.", 409, "SPECIAL_ROUTE_NOT_REQUIRED");
    const handoff = await query("SELECT status FROM sales_special_stock_handoffs WHERE request_id = $1 FOR UPDATE", [id]);
    if (!handoff.rowCount) throw workflowError("Dispatch handoff was not created.", 409, "SPECIAL_HANDOFF_MISSING");
    if (handoff.rows[0].status !== "waiting_route") {
      throw workflowError("The route is immutable after its first selection.", 409, "SPECIAL_ROUTE_LOCKED");
    }
    if (normalized.route === "direct") {
      await createSalesOrderPoAllocations({
        dispatchTargetRef: special.sales_order_ref,
        salesOrderRef: special.sales_order_ref,
        poRef: special.purchase_order_ref,
        lines: await directAllocationLines(id, special),
        createdBy: operatorId
      });
    }
    await query(
      `UPDATE sales_special_stock_handoffs
          SET route = $2, status = 'ready', route_selected_by = $3,
              route_selected_at = now(), updated_at = now()
        WHERE request_id = $1`,
      [id, normalized.route, operatorId]
    );
    await query("UPDATE sales_special_stock_cases SET handoff_route = $2, updated_at = now() WHERE request_id = $1", [id, normalized.route]);
    await bumpCase(id);
    await appendEvent(id, "special_dispatch_route_selected", operatorId, { route: normalized.route });
  });
  return getSpecialStockCase(id, { audience: "dispatch" });
}

export async function listSpecialDispatchHandoffs({ status = "", stages = "", search = "", limit = 100 } = {}) {
  const clauses = [
    "(approval.approved OR handoff.status IN ('planned','in_progress','completed') OR completion.po_completed)",
    "NOT (completion.so_completed AND completion.po_completed)"
  ];
  const params = [];
  const selectedStages = parseStages(stages);
  if (selectedStages.length) { params.push(selectedStages); clauses.push(`workflow.stage = ANY($${params.length}::text[])`); }
  const normalizedStatus = cleanSearch(status, 40).toLowerCase();
  if (normalizedStatus) {
    params.push(normalizedStatus);
    clauses.push(`handoff.status = $${params.length}`);
  }
  const normalizedSearch = cleanSearch(search);
  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    clauses.push(`(request.request_ref ILIKE $${params.length} OR special.sales_order_ref ILIKE $${params.length} OR special.purchase_order_ref ILIKE $${params.length})`);
  }
  params.push(optionalLimit(limit, 100, 200));
  const result = await query(
    `SELECT handoff.request_id
       FROM sales_special_stock_handoffs handoff
       JOIN sales_special_stock_cases special ON special.request_id = handoff.request_id
       JOIN special_stock_workflow_stages workflow ON workflow.request_id = handoff.request_id
       JOIN special_stock_purchase_approval approval ON approval.request_id = handoff.request_id
       JOIN sales_stock_requests request ON request.id = handoff.request_id
       LEFT JOIN purchase_orders purchase ON purchase.netsuite_id = special.purchase_order_netsuite_id
       CROSS JOIN LATERAL (
         SELECT EXISTS (
           SELECT 1 FROM dispatch_order_completion_status completed
            WHERE completed.order_kind = 'SO' AND completed.dispatch_completion_status = 'completed'
              AND lower(btrim(completed.order_ref)) = lower(btrim(special.sales_order_ref))
         ) AS so_completed,
         EXISTS (
           SELECT 1 FROM dispatch_order_completion_status completed
            WHERE completed.order_kind = 'PO' AND completed.dispatch_completion_status = 'completed'
              AND lower(btrim(completed.order_ref)) IN (
                lower(btrim(special.purchase_order_ref)), lower(btrim(purchase.tranid)), lower(btrim(purchase.dispatch_ref))
              )
         ) AS po_completed
       ) completion
      WHERE ${clauses.join(" AND ")}
      ORDER BY handoff.updated_at DESC, handoff.request_id DESC
      LIMIT $${params.length}`,
    params
  );
  return Promise.all(result.rows.map((row) => getSpecialStockCase(row.request_id, { audience: "dispatch" })));
}

export async function requestSpecialCaseClosure(requestId, {
  expectedRevision: revision,
  reason
} = {}, { operatorId, authorizedStoreLocationIds = [] } = {}) {
  const id = positiveId(requestId, "Special Item case");
  const cleanReason = cleanSearch(reason, 2_000);
  if (!cleanReason) throw workflowError("A closure reason is required.", 400, "SPECIAL_CLOSURE_REASON_REQUIRED");
  await withTransaction(async () => {
    const special = await lockCase(id, revision);
    assertNoSpecialQuantityReview(special);
    assertScope(mapCase(special), authorizedStoreLocationIds);
    if ([special.sales_order_operation_status, special.purchase_order_operation_status]
      .some((status) => status === "creating" || status === "attention")) {
      throw workflowError(
        "Resolve the in-flight or uncertain NetSuite order operation before closing this case.",
        409,
        "SPECIAL_CLOSURE_OPERATION_UNRESOLVED"
      );
    }
    const resumeSalesClosure = special.close_status === 'closure_pending' && special.sales_order_netsuite_id
      && !special.purchase_order_netsuite_id && (!special.closure_review?.id || ['pending','attention'].includes(special.closure_review.status));
    if (special.close_status !== 'active' && !resumeSalesClosure) throw workflowError('This request is already closing or closed.', 409, 'SPECIAL_CASE_CLOSED');
    await assertSpecialClosureUnplanned(special);
    const needsScm = Boolean(special.purchase_order_netsuite_id);
    if (special.purchase_order_skipped) throw workflowError('A skipped test PO cannot close live orders.', 409, 'SPECIAL_TEST_ORDER_REMOTE_BLOCKED');
    if (special.sales_order_netsuite_id) assertSpecialStockRemoteOrderAllowed(mapCase(special));
    const pending = Boolean(special.sales_order_netsuite_id);
    if (resumeSalesClosure) {
      if (!special.closure_review?.id) {
        await writeClosureReview(id, { id: crypto.randomUUID(), status: 'pending', requiresScm: false,
          requestedBy: special.closure_requested_by || operatorId, requestedAt: special.closure_requested_at || new Date().toISOString(),
          reason: special.closure_reason || cleanReason });
        await bumpCase(id);
        await appendEvent(id, 'special_closure_resumed', operatorId, { reason: special.closure_reason || cleanReason });
      }
      return;
    }
    await query(
      `UPDATE sales_special_stock_cases
          SET close_status = $2, closure_reason = $3,
              closure_requested_by = $4, closure_requested_at = now(),
              closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END,
              updated_at = now()
        WHERE request_id = $1`,
      [id, pending ? "closure_pending" : "closed", cleanReason, operatorId]
    );
    if (!pending) await query("UPDATE sales_stock_requests SET status = 'cancelled' WHERE id = $1", [id]);
    if (pending) await writeClosureReview(id, { id: crypto.randomUUID(), status: 'pending', requiresScm: needsScm,
      requestedBy: operatorId, requestedAt: new Date().toISOString(), reason: cleanReason });
    await bumpCase(id);
    await appendEvent(id, needsScm ? 'special_closure_waiting_scm' : pending ? "special_closure_waiting_netsuite" : "special_case_closed", operatorId, { reason: cleanReason });
  });
  return getSpecialStockCase(id, { audience: "sales", authorizedStoreLocationIds });
}

async function assertSpecialClosureUnplanned(special,{localOnly=false}={}) {
  const detail = mapCase(special);
  const planning = specialDispatchPlanning(detail, await readSpecialDispatchPlans());
  if (planning.anyPlanned || special.canonical_sales_dispatch_planned) {
    throw workflowError('Unplan both the Sales Order and Purchase Order in Dispatch before requesting closure.',409,'SPECIAL_CLOSURE_PLANNED');
  }
  if(localOnly)return;
  const handoff = (await query('SELECT status FROM sales_special_stock_handoffs WHERE request_id=$1',[detail.id])).rows[0];
  if (detail.operationallyComplete || ['planned','in_progress','completed'].includes(handoff?.status)
    || special.canonical_sales_fulfilled_at || special.canonical_purchase_received_at) {
    throw workflowError('Dispatch or fulfillment has started. Resolve it before closing the request.',409,'SPECIAL_CLOSURE_EXECUTED');
  }
}

function matchingClosureReview(special, reviewId) {
  const review = special.closure_review;
  if (!review?.id || review.id !== reviewId) throw workflowError('This closure request changed. Refresh before reviewing.',409,'SPECIAL_CLOSURE_STALE');
  return review;
}

async function writeClosureReview(id, review) {
  await query('UPDATE sales_special_stock_cases SET closure_review=$2::jsonb,updated_at=now() WHERE request_id=$1',[id,JSON.stringify(review)]);
}

export async function withSpecialClosureReviewLock(requestId, run) {
  const client = await pool.connect(), key = `special-closure-review:${positiveId(requestId,'Special Item case')}`;
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
    if (!locked) throw workflowError('Closure is already running.',409,'SPECIAL_CLOSURE_BUSY');
    return await run();
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>null);
    client.release();
  }
}

export async function claimSpecialClosureReview(requestId,input,context={}) {
  await withTransaction(async()=>{
    const special = await lockCase(requestId,input.expectedRevision), review = matchingClosureReview(special,input.reviewId);
    if (context.salesClosure) {
      assertScope(mapCase(special), context.authorizedStoreLocationIds);
      if (special.purchase_order_netsuite_id) throw workflowError('An issued PO requires SCM confirmation.',403,'SPECIAL_CLOSURE_SCM_REQUIRED');
    }
    if (review.status === 'approved') return;
    if (special.close_status !== 'closure_pending' || !['pending','applying','attention'].includes(review.status)) throw workflowError('There is no pending SCM closure review.',409,'SPECIAL_CLOSURE_STALE');
    assertNoSpecialQuantityReview(special); assertCaseEditable(special); assertSpecialStockRemoteOrderAllowed(mapCase(special));
    await assertSpecialClosureUnplanned(special);
    await writeClosureReview(requestId,{...review,status:'applying',confirmedBy:review.confirmedBy || context.operatorId,
      confirmedAt:review.confirmedAt || new Date().toISOString(),error:null});
    await bumpCase(requestId);
    await appendEvent(requestId,'special_closure_confirmed',context.operatorId,{reviewId:review.id});
  });
  return getSpecialStockCase(requestId,{audience:'scm'});
}

export async function saveSpecialClosurePlan(requestId,{reviewId,plan}) {
  await withTransaction(async()=>{
    const special = await selectCaseRow(requestId,{forUpdate:true}), review = matchingClosureReview(special,reviewId);
    if (review.status !== 'applying' || (review.plan && JSON.stringify(review.plan) !== JSON.stringify(plan))) throw workflowError('The confirmed closure plan cannot change.',409,'SPECIAL_CLOSURE_STALE');
    await assertSpecialClosureUnplanned(special);
    await writeClosureReview(requestId,{...review,plan,remoteStarted:true});
  });
}

export async function finishSpecialClosureReview(requestId,{reviewId,verifiedOrderIds},context={}) {
  await withTransaction(async()=>{
    const special = await selectCaseRow(requestId,{forUpdate:true}), review = matchingClosureReview(special,reviewId);
    const linkedIds = [special.sales_order_netsuite_id,special.purchase_order_netsuite_id].filter(Boolean);
    if (review.status !== 'applying' || !review.remoteStarted || !special.sales_order_netsuite_id
      || !linkedIds.every(id=>verifiedOrderIds.includes(Number(id)))) {
      throw workflowError('Every linked NetSuite order must be verified closed before local cancellation.',409,'SPECIAL_CLOSURE_UNVERIFIED');
    }
    await assertSpecialClosureUnplanned(special);
    await query("UPDATE sales_orders SET status='closed',status_text='Closed' WHERE netsuite_id=$1",[special.sales_order_netsuite_id]);
    await query("UPDATE purchase_orders SET status='closed',status_text='Closed' WHERE netsuite_id=$1",[special.purchase_order_netsuite_id]);
    await query("UPDATE sales_special_stock_cases SET close_status='closed',closed_at=now(),sales_order_status='Closed',purchase_order_status=CASE WHEN purchase_order_netsuite_id IS NOT NULL THEN 'Closed' ELSE purchase_order_status END,attention=false,attention_reason=NULL WHERE request_id=$1",[requestId]);
    await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1",[requestId]);
    await query("UPDATE sales_special_stock_handoffs SET status='cancelled',updated_at=now() WHERE request_id=$1",[requestId]);
    await writeClosureReview(requestId,{...review,status:'approved',completedAt:new Date().toISOString(),error:null});
    await bumpCase(requestId);
    await appendEvent(requestId,'special_case_closed',context.operatorId,{reviewId,verifiedOrderIds,reason:review.reason});
  });
  return getSpecialStockCase(requestId,{audience:'scm'});
}

export async function closeSpecialCaseForClosedOrders(requestId,input,context={}) {
  const id=positiveId(requestId,'Special Item case');
  await withTransaction(async()=>{
    const special=await lockCase(id,input.expectedRevision);
    if(context.salesClosure)assertScope(mapCase(special),context.authorizedStoreLocationIds || []);
    assertNoSpecialQuantityReview(special);assertCaseEditable(special);
    assertSpecialStockRemoteOrderAllowed(mapCase(special));
    if(special.purchase_order_skipped)throw workflowError('A skipped test PO cannot close live orders.',409,'SPECIAL_TEST_ORDER_REMOTE_BLOCKED');
    const orders=assertSpecialClosedOrderEvidence(mapCase(special),input.closedOrders,
      {allowFulfilledSalesOrder:context.allowFulfilledSalesOrder===true});
    if(!['active','closure_pending'].includes(special.close_status))throw workflowError('This request is already closing or closed.',409,'SPECIAL_CASE_CLOSED');
    const review=special.closure_review?.id?special.closure_review:{};
    if(!context.salesClosure) {
      matchingClosureReview(special,input.reviewId);
      if(special.close_status!=='closure_pending' || !['pending','attention','applying'].includes(review.status)) {
        throw workflowError('There is no pending SCM closure review.',409,'SPECIAL_CLOSURE_STALE');
      }
    }
    const reason=cleanSearch(context.salesClosure?input.reason:review.reason,2000);
    if(!reason)throw workflowError('A closure reason is required.',400,'SPECIAL_CLOSURE_REASON_REQUIRED');
    await assertSpecialClosureUnplanned(special,{localOnly:true});
    for(const order of orders) {
      const table=order.kind==='sales_order'?'sales_orders':'purchase_orders';
      await query(`UPDATE ${table} SET status=$2,status_text=$3 WHERE netsuite_id=$1`,
        [order.id,order.fullyFulfilled?'F':'closed',order.statusText]);
    }
    const so=orders.find(o=>o.kind==='sales_order'),po=orders.find(o=>o.kind==='purchase_order');
    await query(`UPDATE sales_special_stock_cases SET close_status='closed',closed_at=now(),closure_reason=$2,
      closure_requested_by=COALESCE(closure_requested_by,$3),closure_requested_at=COALESCE(closure_requested_at,now()),
      sales_order_status=$4,purchase_order_status=COALESCE($5,purchase_order_status),attention=false,attention_reason=NULL WHERE request_id=$1`,
    [id,reason,context.operatorId || null,so.statusText,po?.statusText || null]);
    await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1",[id]);
    await query("UPDATE sales_special_stock_handoffs SET status=CASE WHEN status='completed' THEN status ELSE 'cancelled' END,updated_at=now() WHERE request_id=$1",[id]);
    const completed={...review,id:review.id || crypto.randomUUID(),status:'approved',reason,localOnly:true,
      remoteStarted:review.remoteStarted===true,verifiedOrders:orders,confirmedBy:review.confirmedBy || context.operatorId || null,
      confirmedAt:review.confirmedAt || new Date().toISOString(),completedAt:new Date().toISOString(),error:null};
    await writeClosureReview(id,completed);await bumpCase(id);
    await appendEvent(id,'special_case_closed',context.operatorId,{reviewId:completed.id,reason,localOnly:true,verifiedOrders:orders});
  });
  return getSpecialStockCase(id,{audience:context.salesClosure?'sales':'scm',
    authorizedStoreLocationIds:context.salesClosure?context.authorizedStoreLocationIds:undefined});
}

export async function rejectSpecialClosureReview(requestId,input,context={}) {
  await withTransaction(async()=>{
    const special = await lockCase(requestId,input.expectedRevision), review = matchingClosureReview(special,input.reviewId);
    if (!['pending','attention'].includes(review.status) || review.remoteStarted) throw workflowError('Closure has started in NetSuite. Retry confirmation to finish both orders.',409,'SPECIAL_CLOSURE_BUSY');
    await writeClosureReview(requestId,{...review,status:'rejected',reviewedBy:context.operatorId,reviewNote:cleanSearch(input.reason,2000),completedAt:new Date().toISOString()});
    await query("UPDATE sales_special_stock_cases SET close_status='active',closure_reason=NULL WHERE request_id=$1",[requestId]);
    await bumpCase(requestId);
    await appendEvent(requestId,'special_closure_rejected',context.operatorId,{reviewId:review.id,reason:cleanSearch(input.reason,2000)});
  });
  return getSpecialStockCase(requestId,{audience:'scm'});
}

export async function failSpecialClosureReview(requestId,{reviewId,errorMessage},context={}) {
  await withTransaction(async()=>{
    const special = await selectCaseRow(requestId,{forUpdate:true}), review = matchingClosureReview(special,reviewId);
    if (review.status !== 'applying') return;
    await writeClosureReview(requestId,{...review,status:'attention',error:cleanSearch(errorMessage,2000)});
    await bumpCase(requestId);
    await appendEvent(requestId,'special_closure_attention',context.operatorId,{reviewId,error:cleanSearch(errorMessage,2000)});
  });
}

export async function completeSpecialVendorPickup(requestId, input = {}, {
  operatorId,
  authorizedStoreLocationIds = []
} = {}) {
  const id = positiveId(requestId, "Special Item case");
  const completion = normalizeSpecialVendorPickupCompletion(input);
  await withTransaction(async () => {
    const special = await lockCase(id, input.expectedRevision);
    assertNoSpecialQuantityReview(special);
    assertScope(mapCase(special), authorizedStoreLocationIds);
    if (special.fulfillment_method !== "vendor_pickup") {
      throw workflowError("Only customer pickup at vendor can be completed by Sales.", 409, "SPECIAL_VENDOR_PICKUP_METHOD_REQUIRED");
    }
    if (!(special.sales_order_netsuite_id || special.sales_order_skipped) || !(special.purchase_order_netsuite_id || special.purchase_order_skipped)) {
      throw workflowError("Both Sales Order and Purchase Order are required before customer pickup completion.", 409, "SPECIAL_VENDOR_PICKUP_ORDERS_REQUIRED");
    }
    if (special.post_po_change_pending === true || special.attention === true) {
      throw workflowError("Resolve the case Attention state before completing customer pickup.", 409, "SPECIAL_VENDOR_PICKUP_ATTENTION");
    }
    if (!special.purchase_order_skipped) await assertPurchaseApproved(special);
    assertCaseEditable(special);
    assertStockReady(await lineRows(id, { forUpdate: true }));
    if (special.operationally_complete === true) {
      throw workflowError("Customer pickup is already complete.", 409, "SPECIAL_VENDOR_PICKUP_ALREADY_COMPLETE");
    }
    await query(
      `UPDATE sales_special_stock_cases
          SET operationally_complete = true,
              operationally_completed_at = now(),
              operational_completion_source = 'vendor_pickup',
              operationally_completed_by = $2,
              vendor_pickup_date = $3,
              vendor_pickup_reference = $4,
              updated_at = now()
        WHERE request_id = $1`,
      [id, operatorId, completion.pickupDate, completion.pickupReference]
    );
    await bumpCase(id);
    await appendEvent(id, "special_vendor_pickup_completed", operatorId, completion);
  });
  return getSpecialStockCase(id, { audience: "sales", authorizedStoreLocationIds });
}

export async function acknowledgeSpecialPostPoChange(requestId, {
  expectedRevision: revision,
  acknowledgement
} = {}, { operatorId, authorizedStoreLocationIds = [] } = {}) {
  const id = positiveId(requestId, "Special Item case");
  const note = cleanSearch(acknowledgement, 2_000);
  if (!note) throw workflowError("Customer acknowledgement is required.", 400, "SPECIAL_ACK_REQUIRED");
  await withTransaction(async () => {
    const special = await lockCase(id, revision);
    assertScope(mapCase(special), authorizedStoreLocationIds);
    if (special.post_po_change_pending !== true) throw workflowError("There is no pending vendor change to acknowledge.", 409, "SPECIAL_ACK_NOT_PENDING");
    await query(
      `UPDATE sales_special_stock_cases
          SET post_po_change_pending = false,
              post_po_change_acknowledged_by = $2,
              post_po_change_acknowledged_at = now(), updated_at = now()
        WHERE request_id = $1`,
      [id, operatorId]
    );
    await bumpCase(id);
    await appendEvent(id, "special_post_po_change_acknowledged", operatorId, { acknowledgement: note });
  });
  return getSpecialStockCase(id, { audience: "sales", authorizedStoreLocationIds });
}

export async function issueSpecialStockMedia(requestId, {
  mimeType,
  byteSize
} = {}, { operatorId, authorizedStoreLocationIds = [] } = {}) {
  const id = positiveId(requestId, "Special Item case");
  const normalizedMime = String(mimeType || "").trim().toLowerCase();
  const normalizedBytes = Number(byteSize);
  if (!/^(image|video)\/[a-z0-9.+-]+$/i.test(normalizedMime)
      || !Number.isSafeInteger(normalizedBytes) || normalizedBytes < 1 || normalizedBytes > 25 * 1024 * 1024) {
    throw workflowError("Delivery media must be an image/video no larger than 25 MB.", 400, "SPECIAL_SO_MEDIA_INVALID");
  }
  const uploadId = crypto.randomUUID();
  await withTransaction(async () => {
    const detail = mapCase(await selectCaseRow(id, { forUpdate: true }));
    assertScope(detail, authorizedStoreLocationIds);
    if (detail.salesOrderId || detail.salesOrderSkipped) throw workflowError("Delivery media is locked after Sales Order creation.", 409, "SPECIAL_SO_MEDIA_LOCKED");
    await query(
      `INSERT INTO sales_special_stock_media (
         upload_id, request_id, mime_type, byte_size, status, created_by
       ) VALUES ($1,$2,$3,$4,'issued',$5)`,
      [uploadId, id, normalizedMime, normalizedBytes, operatorId]
    );
  });
  return { id: uploadId, requestId: id, mimeType: normalizedMime, byteSize: normalizedBytes };
}

export async function registerSpecialStockMedia(requestId, uploadId, {
  objectRef,
  mimeType,
  byteSize
} = {}, { operatorId, authorizedStoreLocationIds = [] } = {}) {
  const id = positiveId(requestId, "Special Item case");
  const ref = String(objectRef || "").trim();
  if (!ref.startsWith("r2://")) throw workflowError("A durable R2 media reference is required.", 400, "SPECIAL_SO_MEDIA_REF_INVALID");
  await withTransaction(async () => {
    const detail = mapCase(await selectCaseRow(id, { forUpdate: true }));
    assertScope(detail, authorizedStoreLocationIds);
    const result = await query(
      `UPDATE sales_special_stock_media
          SET object_ref = $3, status = 'staged', registered_at = now()
        WHERE request_id = $1 AND upload_id = $2 AND status = 'issued'
          AND mime_type = $4 AND byte_size = $5
        RETURNING upload_id`,
      [id, uploadId, ref, String(mimeType || "").toLowerCase(), Number(byteSize)]
    );
    if (!result.rowCount) throw workflowError("The media upload ticket is missing, stale, or does not match the upload.", 409, "SPECIAL_SO_MEDIA_TICKET_MISMATCH");
    await appendEvent(id, "special_delivery_media_staged", operatorId, { uploadId, mimeType, byteSize });
  });
  return getSpecialStockCase(id, { audience: "sales", authorizedStoreLocationIds });
}

export async function searchSpecialCustomers({ search = "", limit = 30 } = {}) {
  return searchSpecialCustomerDirectory(search,limit);
}

export async function searchSpecialItems({ search = "", limit = 30 } = {}) {
  const term = cleanSearch(search);
  const result = await query(
    `SELECT item_id, item_name, display_name, item_description, stock_unit,
            brand, to_plt, to_lyr, to_sec, to_pcs
       FROM inventory_items
      WHERE ($1 = '%%' OR item_name ILIKE $1 OR display_name ILIKE $1 OR item_description ILIKE $1)
      ORDER BY item_name, item_id
      LIMIT $2`,
    [`%${term}%`, optionalLimit(limit, 30, 80)]
  );
  return result.rows.map((row) => ({
    itemId: Number(row.item_id),
    itemName: row.item_name,
    displayName: row.display_name || row.item_name,
    description: row.item_description || "",
    stockUnit: row.stock_unit || "",
    brand: row.brand || "",
    toPlt: numberOrNull(row.to_plt),
    toLyr: numberOrNull(row.to_lyr),
    toSec: numberOrNull(row.to_sec),
    toPcs: numberOrNull(row.to_pcs)
  }));
}

export async function searchSpecialVendors({ search = "", limit = 30 } = {}) {
  const term = `%${cleanSearch(search)}%`;
  const result = await query(
    `WITH candidates AS (
       SELECT vendor_id::text AS vendor_key, vendor AS vendor, 2 AS source_priority
         FROM purchase_orders
        WHERE vendor_id IS NOT NULL AND NULLIF(btrim(vendor), '') IS NOT NULL
       UNION ALL
       SELECT NULLIF(btrim(netsuite_vendor_id), '') AS vendor_key,
              COALESCE(NULLIF(btrim(netsuite_vendor_name), ''), NULLIF(btrim(local_vendor), '')) AS vendor,
              1 AS source_priority
         FROM dispatch_vendor_mappings
        WHERE active = true
          AND COALESCE(NULLIF(btrim(netsuite_vendor_name), ''), NULLIF(btrim(local_vendor), '')) IS NOT NULL
     ), ranked AS (
       SELECT vendor_key, vendor,
              row_number() OVER (
                PARTITION BY COALESCE(vendor_key, lower(vendor))
                ORDER BY source_priority DESC, vendor
              ) AS candidate_rank
         FROM candidates
        WHERE $1 = '%%' OR vendor ILIKE $1 OR COALESCE(vendor_key, '') ILIKE $1
     )
     SELECT CASE WHEN vendor_key ~ '^[0-9]+$' THEN vendor_key::bigint ELSE NULL END AS vendor_id,
            vendor
       FROM ranked
      WHERE candidate_rank = 1
      ORDER BY vendor, vendor_id NULLS LAST
      LIMIT $2`,
    [term, optionalLimit(limit, 30, 80)]
  );
  return result.rows.map((row) => ({ id: numberOrNull(row.vendor_id), name: row.vendor }));
}

export async function searchSpecialOrderLinks({ kind, search = "", limit = 30 } = {}) {
  const term = `%${cleanSearch(search)}%`;
  if (kind === "sales_order") {
    const result = await query(
      `SELECT netsuite_id, tranid, customer_id, customer, status_text, order_location_id
         FROM sales_orders
        WHERE netsuite_active = true AND (tranid ILIKE $1 OR customer ILIKE $1)
        ORDER BY trandate DESC NULLS LAST, netsuite_id DESC LIMIT $2`,
      [term, optionalLimit(limit, 30, 80)]
    );
    return result.rows.map((row) => ({
      id: Number(row.netsuite_id), ref: row.tranid, entityId: numberOrNull(row.customer_id),
      entityName: row.customer || "", status: row.status_text || "", locationId: numberOrNull(row.order_location_id)
    }));
  }
  if (kind === "purchase_order") {
    const result = await query(
      `SELECT netsuite_id, tranid, vendor_id, vendor, status_text, destination_location_id
         FROM purchase_orders
        WHERE COALESCE(netsuite_active, true) = true AND (tranid ILIKE $1 OR vendor ILIKE $1)
        ORDER BY trandate DESC NULLS LAST, netsuite_id DESC LIMIT $2`,
      [term, optionalLimit(limit, 30, 80)]
    );
    return result.rows.map((row) => ({
      id: Number(row.netsuite_id), ref: row.tranid, entityId: numberOrNull(row.vendor_id),
      entityName: row.vendor || "", status: row.status_text || "", locationId: numberOrNull(row.destination_location_id)
    }));
  }
  throw workflowError("Select sales_order or purchase_order.");
}

function assertStockReady(rows) {
  if (!rows.some(row => row.sales_decision === 'accepted') || rows.some(row => row.sales_decision === 'accepted' && !specialStockAvailable(row.supply_status))) {
    throw workflowError('SCM must confirm every accepted product is ready before collection or Dispatch.', 409, 'SPECIAL_STOCK_NOT_READY');
  }
}

/** @param {any} requestId @param {any} [input] @param {{operatorId?:string}} [context] */
export async function prepareSpecialPurchaseOrder(requestId, input = {}, { operatorId } = {}) {
  const id = positiveId(requestId, 'Special Item case');
  await withTransaction(async () => {
    const special = await lockCase(id, input.expectedRevision);
    assertNoSpecialQuantityReview(special);
    const ownUnsubmittedRetry = special.purchase_order_operation_status === 'attention' && !special.purchase_order_submission_started_at
      && input.operationId && input.operationId === special.purchase_order_operation_id;
    assertCaseEditable(ownUnsubmittedRetry ? { ...special, purchase_order_operation_status: 'idle' } : special);
    if (special.close_status !== 'active' || !(special.sales_order_netsuite_id || special.sales_order_skipped) || !special.sales_order_approved || special.purchase_order_netsuite_id || special.purchase_order_skipped) {
      throw workflowError('An active, approved SO without a PO is required.', 409, 'SPECIAL_PO_SO_NOT_APPROVED');
    }
    const palletInput = input.pallet ?? (Number(special.pallet_total || 0) === 0 ? {quantity:0} : null);
    if (!palletInput) throw workflowError('Review the PALLET quantity and purchase cost before creating the PO.',400,'SPECIAL_PO_PALLET_REQUIRED');
    const pallet = specialPurchasePalletLine(palletInput);
    const accepted = (await lineRows(id, { forUpdate: true })).filter(row => row.sales_decision === 'accepted');
    const lines = input.lines;
    if (!Array.isArray(lines) || !accepted.length || lines.length !== accepted.length || new Set(lines.map(line => Number(line.caseLineId))).size !== accepted.length) {
      throw workflowError('Review every accepted product exactly once.', 400, 'SPECIAL_PO_LINES_INVALID');
    }
    let review;
    try { review = specialVendorLineDiscountReview(lines); }
    catch (error) {
      if (['SPECIAL_RATE_INVALID','SPECIAL_QUANTITY_INVALID'].includes(error.code)) throw workflowError('Each PO product needs description, purchase UOM, quantity and a non-negative cost.', 400, 'SPECIAL_PO_LINES_INVALID');
      throw error;
    }
    for (const line of review.lines) {
      const row = accepted.find(candidate => Number(candidate.id) === Number(line.caseLineId));
      const description = cleanSearch(line.description, 4000);
      const uom = cleanSearch(line.uom, 40).toUpperCase();
      const quantity = Number(line.quantity);
      const cost = Number(line.unitPurchaseCost);
      if (!row || !description || !uom || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1e9 || line.unitPurchaseCost === '' || line.unitPurchaseCost == null || !Number.isFinite(cost) || cost < 0 || cost > 1e9) {
        throw workflowError('Each PO product needs description, purchase UOM, quantity and a non-negative cost.', 400, 'SPECIAL_PO_LINES_INVALID');
      }
      await query(`UPDATE sales_special_stock_order_lines SET description=$3, quantity=$4, uom=$5, unit_purchase_cost=$6, updated_at=now()
        WHERE request_id=$1 AND case_line_id=$2 AND order_kind='purchase_order'`, [id, row.id, description, quantity, uom, cost]);
      await query(`UPDATE sales_special_stock_lines SET resolved_description=$3, purchase_quantity=$4, purchase_uom=$5, unit_purchase_cost=$6,
        po_ready=true, po_ready_by=$7, po_ready_at=now(), po_ready_response_revision=response_revision, updated_at=now()
        WHERE request_id=$1 AND id=$2`, [id, row.id, description, quantity, uom, cost, operatorId]);
    }
    await query("DELETE FROM sales_special_stock_order_lines WHERE request_id=$1 AND order_kind='purchase_order' AND item_id=1784",[id]);
    if (pallet) {
      const item = await query('SELECT item_name FROM inventory_items WHERE item_id=1784 FOR SHARE');
      if (!item.rowCount) throw workflowError('PALLET is missing from the synced item master.',409,'SPECIAL_SO_ITEM_NOT_FOUND');
      await query(`INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_purchase_cost)
        VALUES($1,'purchase_order',true,1784,$2,$3,$4,'EACH',$5)`,[id,item.rows[0].item_name,pallet.description,pallet.quantity,pallet.unitPurchaseCost]);
    }
    const confirmed = { ...review, pallet:{quantity:pallet?.quantity ?? 0,unitPurchaseCost:pallet?.unitPurchaseCost ?? null}, confirmedBy: operatorId, confirmedAt: new Date().toISOString() };
    await query('UPDATE sales_special_stock_cases SET vendor_discount_review=$2::jsonb WHERE request_id=$1',[id,JSON.stringify(confirmed)]);
    await appendEvent(id, 'special_vendor_discount_confirmed', operatorId, confirmed, { audience: 'scm' });
    await bumpCase(id);
    await appendEvent(id, 'special_purchase_order_reviewed', operatorId, { count: lines.length });
  });
  return getSpecialStockCase(id, { audience: 'scm' });
}

export async function skipSpecialOrderCreation(requestId, input = {}, context = {}) {
  const id = positiveId(requestId, 'Special Item case');
  const field = input.orderKind;
  if (!['sales_order', 'purchase_order'].includes(field)) throw workflowError('Select a supported order step.');
  await withTransaction(async () => {
    // Keep the gate locked until the skip commits, including any PO review.
    const gates = await query('SELECT flag_key, enabled FROM mbt_feature_flags WHERE flag_key = ANY($1::text[]) ORDER BY flag_key FOR SHARE',
      [[SPECIAL_STOCK_REQUEST_FLAG_KEY, SPECIAL_STOCK_TEST_SKIP_FLAG_KEY]]);
    if (gates.rowCount !== 2 || gates.rows.some(row => row.enabled !== true)) {
      throw workflowError('Order creation skips are disabled.', 404, 'SPECIAL_TEST_SKIP_DISABLED');
    }
    const special = await lockCase(id, input.expectedRevision);
    assertNoSpecialQuantityReview(special);
    assertNoSpecialLineDecisionReview(special);
    if (field === 'sales_order' && special.fulfillment_method === 'mbt_delivery') assertSpecialDeliveryDate(dateValue(special.delivery_date));
    assertScope(mapCase(special), context.authorizedStoreLocationIds);
    assertCaseEditable(special);
    if (special.close_status !== 'active' || special.operationally_complete) throw workflowError('This request is closed or completed.', 409, 'SPECIAL_CASE_CLOSED');
    if (special[`${field}_skipped`]) return;
    if (special[`${field}_netsuite_id`]) throw workflowError('An order is already linked.', 409, field === 'sales_order' ? 'SPECIAL_SO_ALREADY_LINKED' : 'SPECIAL_PO_ALREADY_LINKED');
    if (special[`${field}_submission_started_at`]) throw workflowError('Resolve the submitted NetSuite operation before skipping.', 409, 'SPECIAL_OPERATION_BUSY');
    assertSpecialOrderRelease((await lineRows(id, { forUpdate: true })).map(mapLine));
    if (field === 'sales_order') {
      const count = await query("SELECT count(*)::int AS count FROM sales_special_stock_order_lines WHERE request_id=$1 AND order_kind='sales_order'", [id]);
      if (!Number(count.rows[0]?.count) || special.pallet_total == null) throw workflowError('Save the Sales Order draft first.', 409, 'SPECIAL_SO_DRAFT_REQUIRED');
      await query('UPDATE sales_special_stock_cases SET sales_order_skipped=true, sales_order_approved=true WHERE request_id=$1', [id]);
    } else {
      if (special.canonical_sales_dispatch_planned) throw workflowError('Unplan the Sales Order before skipping the PO.', 409, 'SPECIAL_PO_SO_ALREADY_PLANNED');
      await prepareSpecialPurchaseOrder(id, input, context);
      // A simulated SO can be updated locally. Never edit an existing real SO
      // while skipping the PO, and never claim that its description was synced.
      if (special.sales_order_skipped) {
        await query(`UPDATE sales_special_stock_order_lines so SET description=po.description, updated_at=now()
          FROM sales_special_stock_order_lines po WHERE so.request_id=$1 AND po.request_id=so.request_id
            AND po.case_line_id=so.case_line_id AND so.order_kind='sales_order' AND po.order_kind='purchase_order'`, [id]);
      }
      await query('UPDATE sales_special_stock_cases SET purchase_order_skipped=true WHERE request_id=$1', [id]);
    }
    await bumpCase(id);
    await appendEvent(id, `special_${field}_creation_skipped`, context.operatorId,
      { testing: true, gate: SPECIAL_STOCK_TEST_SKIP_FLAG_KEY, netSuiteOrderCreated: false });
  });
  return getSpecialStockCase(id, { audience: field === 'sales_order' ? 'sales' : 'scm', authorizedStoreLocationIds: context.authorizedStoreLocationIds });
}

export async function recordSpecialSalesDescriptionsSynced(requestId, { expectedRevision: revision, operationId, changes = [] } = {}, { operatorId } = {}) {
  const id = positiveId(requestId, 'Special Item case');
  await withTransaction(async () => {
    const special = await lockOwnedOrderOperation(id, revision, 'purchase_order', operationId);
    for (const change of changes) {
      const result = await query(`UPDATE sales_special_stock_order_lines SET description=$4,quantity=$6,uom=$7,updated_at=now()
        WHERE request_id=$1 AND case_line_id=$2 AND remote_line_id=$3 AND order_kind='sales_order'
          AND item_id=2055 AND ((description=$5 AND quantity=$9 AND uom=$10) OR (description=$4 AND quantity=$6 AND uom=$7))
          AND unit_rate IS NOT DISTINCT FROM $8 RETURNING id`,
      [id, change.caseLineId, change.remoteLineId, change.description, change.previousDescription, change.quantity, change.uom, change.rate ?? null,
        change.previousQuantity ?? change.quantity, change.previousUom ?? change.uom]);
      if (result.rowCount !== 1) throw workflowError('The linked SO line changed during synchronization.', 409, 'SPECIAL_SO_LINE_CONFLICT');
      await query(`UPDATE sales_order_lines SET item_description=$3,quantity=$4,unit=$5 WHERE sales_order_id=$1 AND line_id=$2 AND item_id=2055`, [special.sales_order_netsuite_id, change.remoteLineId, change.description, change.quantity, change.uom]);
      await query(`UPDATE sales_special_stock_lines SET sales_quantity=$3,sales_uom=$4,updated_at=now() WHERE request_id=$1 AND id=$2`, [id, change.caseLineId, change.quantity, change.uom]);
    }
    await bumpCase(id);
    await appendEvent(id, 'special_sales_descriptions_synchronized', operatorId, { changes });
  });
  return getSpecialStockCase(id, { audience: 'scm' });
}

async function writeSpecialReadiness(requestId, lineId, input = {}, { operatorId } = {}) {
  const id = positiveId(requestId, 'Special Item case');
  if (typeof input.ready !== 'boolean') throw workflowError('Confirm ready or not ready.', 400, 'SPECIAL_READINESS_REQUIRED');
  const eta = input.ready ? null : String(input.eta || '');
  if (!input.ready && (!/^\d{4}-\d{2}-\d{2}$/.test(eta) || Number.isNaN(Date.parse(`${eta}T12:00:00Z`)) || new Date(`${eta}T12:00:00Z`).toISOString().slice(0,10) !== eta)) {
    throw workflowError('A valid revised ETA is required when stock is not ready.', 400, 'SPECIAL_ETA_REQUIRED');
  }
  const special = await lockCase(id, input.expectedRevision);
  assertCaseEditable(special);
  if (special.close_status !== 'active' || special.operationally_complete || mapCase(special).operationallyComplete) throw workflowError('This request is already closed or completed.', 409, 'SPECIAL_CASE_CLOSED');
  const rows = await lineRows(id, { forUpdate: true });
  const line = rows.find(row => Number(row.id) === Number(lineId));
  if (!line || line.sales_decision !== 'accepted') throw workflowError('Only an accepted product can receive a readiness check.', 409, 'SPECIAL_READINESS_LINE_INVALID');
  const due = nextReminderDate({ previousDue: dateValue(line.reminder_due_date), eta, ready: input.ready });
  const supplyStatus = input.ready ? (line.supply_status === 'low_inventory' ? 'low_inventory' : 'in_stock') : line.supply_status === 'vendor_transfer' ? 'vendor_transfer' : 'production';
  await query(`UPDATE sales_special_stock_lines SET supply_status=$3, available_date=$4, availability_mode=$5,
    reminder_due_date=$6, stock_checked_at=now(), stock_checked_by=$7, updated_at=now() WHERE request_id=$1 AND id=$2`,
  [id, line.id, supplyStatus, eta, input.ready ? 'no_projection' : 'dated', due, operatorId]);
  if ((special.purchase_order_netsuite_id || special.purchase_order_skipped) && !input.ready && (specialStockAvailable(line.supply_status) || dateValue(line.available_date) !== eta)) {
    await query('UPDATE sales_special_stock_cases SET post_po_change_pending=true, post_po_change_details=$2::jsonb WHERE request_id=$1', [id, JSON.stringify({ lineId: Number(line.id), previousEta: dateValue(line.available_date), eta, ready: false })]);
  }
  if (input.ready && await canonicalLinksReady(id)) await upsertHandoff(id, special);
  await appendEvent(id, 'special_stock_readiness_checked', operatorId, { ready: input.ready, eta, reminderDueDate: due }, { lineId: line.id });
}

export async function checkSpecialStockReadiness(requestId, lineId, input = {}, context = {}) {
  await withTransaction(async () => {
    await writeSpecialReadiness(requestId, lineId, input, context);
    await bumpCase(positiveId(requestId, 'Special Item case'));
  });
  return getSpecialStockCase(requestId, { audience: 'scm' });
}

export async function closeSpecialUnavailableCase(requestId, input = {}, { operatorId } = {}) {
  const id = positiveId(requestId, 'Special Item case');
  const reason = cleanSearch(input.reason, 2000);
  if (!reason) throw workflowError('A closure reason is required.', 400, 'SPECIAL_CLOSURE_REASON_REQUIRED');
  await withTransaction(async () => {
    const special = await lockCase(id, input.expectedRevision);
    assertCaseEditable(special);
    if (special.sales_order_netsuite_id || special.purchase_order_netsuite_id || special.sales_order_skipped || special.purchase_order_skipped || special.close_status !== 'active') throw workflowError('SCM can close only an active enquiry without orders.', 409, 'SPECIAL_CLOSURE_ORDERS_EXIST');
    const rows = await lineRows(id, { forUpdate: true });
    if (!rows.length || rows.some(row => row.supply_status !== 'no_stock' || row.available_date)) throw workflowError('Every product must have no stock and no ETA for SCM closure.', 409, 'SPECIAL_CLOSURE_STOCK_AVAILABLE');
    await query(`UPDATE sales_special_stock_cases SET close_status='closed', closure_reason=$2, closure_requested_by=$3,
      closure_requested_at=now(), closed_at=now(), updated_at=now() WHERE request_id=$1`, [id, reason, operatorId]);
    await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1", [id]);
    await bumpCase(id);
    await appendEvent(id, 'special_case_closed', operatorId, { reason, source: 'scm_no_eta' });
  });
  return getSpecialStockCase(id, { audience: 'scm' });
}

export async function markSpecialOrderSubmitted(requestId, { expectedRevision: revision, orderKind, operationId }, { operatorId } = {}) {
  const field = orderKind === 'sales_order' ? 'sales_order' : orderKind === 'purchase_order' ? 'purchase_order' : null;
  if (!field) throw workflowError('Invalid order kind.');
  await withTransaction(async () => {
    const row = await lockOwnedOrderOperation(requestId, revision, field, operationId);
    assertNoSpecialQuantityReview(row);
    if (row.close_status !== 'active') throw workflowError('A closing or closed case cannot submit an order.', 409, 'SPECIAL_CASE_CLOSED');
    if (field === 'purchase_order') {
      if (!row.sales_order_netsuite_id || !row.sales_order_approved || row.canonical_sales_active === false
        || /pending approval|closed|cancel/i.test(`${row.canonical_sales_status || ''} ${row.canonical_sales_status_text || ''}`)) {
        throw workflowError('The Sales Order must remain approved and active before PO submission.', 409, 'SPECIAL_PO_SO_NOT_APPROVED');
      }
      if (row.canonical_sales_dispatch_planned) throw workflowError('Unplan the Sales Order before creating its Special Item Purchase Order.', 409, 'SPECIAL_PO_SO_ALREADY_PLANNED');
      await reconcileCanonicalOrderLines(requestId, 'sales_order', row.sales_order_netsuite_id);
    }
    if (field === 'sales_order' && row.fulfillment_method === 'mbt_delivery') assertSpecialDeliveryDate(dateValue(row.delivery_date));
    if (row[`${field}_operation_status`] !== 'creating' || row[`${field}_operation_id`] !== operationId || row[`${field}_submission_started_at`]) {
      throw workflowError('This submission has already started; recover it using the order marker.', 409, 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN');
    }
    await query(`UPDATE sales_special_stock_cases SET ${field}_submission_started_at=now() WHERE request_id=$1`, [requestId]);
    await bumpCase(requestId);
    await appendEvent(requestId, `special_${field}_submission_started`, operatorId, { operationId });
  });
  return getSpecialStockCase(requestId, { audience: 'scm' });
}

async function assertQuantityActionAllowed(special) {
  if (['applying','attention'].includes(special.fulfillment_change?.status)) throw workflowError('Finish the saved delivery update first.',409,'SPECIAL_FULFILLMENT_PENDING');
  const detail = mapCase(special);
  const planning = specialDispatchPlanning(detail, await readSpecialDispatchPlans());
  if (special.close_status !== 'active' || detail.operationallyComplete || detail.remotelyReconciled
      || planning.anyPlanned || special.canonical_sales_dispatch_planned || terminalSalesOrder(special) || terminalPurchaseOrder(special)) {
    throw workflowError('Unplan the orders and resolve any completed fulfillment before changing quantities.',409,'SPECIAL_QUANTITY_LOCKED');
  }
  const handoff = await query('SELECT status FROM sales_special_stock_handoffs WHERE request_id=$1 FOR UPDATE',[detail.id]);
  if (handoff.rows.some(row => ['planned','in_progress','completed'].includes(row.status))) throw workflowError('The order is already in Dispatch execution.',409,'SPECIAL_QUANTITY_LOCKED');
  if ((special.sales_order_skipped || special.purchase_order_skipped) && (special.sales_order_netsuite_id || special.purchase_order_netsuite_id)) {
    throw workflowError('A mixed real/test order pair cannot update live order quantities.',409,'SPECIAL_TEST_ORDER_REMOTE_BLOCKED');
  }
}

async function writeQuantityReview(id, review) {
  await query('UPDATE sales_special_stock_cases SET quantity_review=$2::jsonb,updated_at=now() WHERE request_id=$1',[id,JSON.stringify(review)]);
}

function matchingQuantityReview(special, reviewId) {
  const review = special.quantity_review;
  if (!review?.id || String(reviewId) !== review.id) throw workflowError('This quantity proposal changed. Refresh before reviewing.',409,'SPECIAL_QUANTITY_REVIEW_STALE');
  return review;
}

export async function requestSpecialQuantityChange(requestId, input, context = {}) {
  const id = positiveId(requestId,'Special Item case');
  await withTransaction(async () => {
    const special = await lockCase(id,input.expectedRevision);
    assertScope(mapCase(special),context.authorizedStoreLocationIds);
    assertCaseEditable(special);
    await assertQuantityActionAllowed(await selectCaseRow(id));
    if (!special.sales_order_netsuite_id && !special.sales_order_skipped) throw workflowError('Edit and save the SO draft before SO issuance.',409,'SPECIAL_SO_NOT_LINKED');
    const detail = await getSpecialStockCase(id,{audience:'scm'});
    const accepted = detail.lines.filter(line=>line.salesDecision==='accepted');
    if (!Array.isArray(input.lines) || input.lines.length !== accepted.length || new Set(input.lines.map(line=>Number(line.caseLineId))).size !== accepted.length) {
      throw workflowError('Provide each accepted product quantity exactly once.',400,'SPECIAL_QUANTITY_LINES_INVALID');
    }
    const changes = input.lines.flatMap(line => {
      const before = accepted.find(item=>item.id===Number(line.caseLineId));
      if (!before) throw workflowError('This product is not an accepted case line.',400,'SPECIAL_QUANTITY_LINES_INVALID');
      const so = detail.salesOrderLines.find(item=>item.caseLineId===before.id);
      const po = detail.purchaseOrderLines.find(item=>item.caseLineId===before.id);
      if (!so || !po || !before.conversionToPc) throw workflowError('The original order conversion or exact order lines are missing.',409,'SPECIAL_QUANTITY_LINES_INVALID');
      const discount = normalizeSpecialDiscount(line.discountPercent ?? before.discountPercent);
      if (Number(line.quantity)===before.packageQuantity && discount===before.discountPercent) return [];
      const nativeDiscount = so.nativeDiscountPercent != null || discount!==before.discountPercent;
      const pricing = nativeDiscount ? specialNativeLinePricing : specialNativePricing;
      const price = pricing({quantity:line.quantity,rate:before.originalRate,discountPercent:discount,conversionToPc:before.conversionToPc});
      const previous = (so.nativeDiscountPercent != null ? specialNativeLinePricing : specialNativePricing)({quantity:before.packageQuantity,rate:before.originalRate,discountPercent:before.discountPercent,conversionToPc:before.conversionToPc});
      if (previous.rate!==so.rate) throw workflowError('The issued rate no longer matches its recorded price basis.',409,'SPECIAL_RATE_LOCKED');
      const toPurchaseQuantity = specialQuantity(Number((po.quantity * price.quantity / so.quantity).toFixed(6)));
      return [{caseLineId:before.id,productName:before.productName,packageUom:before.rateUom,
        fromPackageQuantity:before.packageQuantity,toPackageQuantity:price.packageQuantity,
        fromConversion:before.conversionToPc,toConversion:before.conversionToPc,
        fromQuantity:so.quantity,toQuantity:price.quantity,fromPurchaseQuantity:po.quantity,toPurchaseQuantity,
        fromDiscountPercent:before.discountPercent,toDiscountPercent:discount,fromRate:so.rate,toRate:price.rate,
        fromNativeDiscountPercent:so.nativeDiscountPercent ?? null,toNativeDiscountPercent:nativeDiscount ? discount : null,
        salesUom:so.uom,purchaseUom:po.uom}];
    });
    const fromPallets = specialPalletQuantity(detail.palletTotal ?? 0);
    const toPallets = input.palletTotal === undefined ? fromPallets : specialPalletQuantity(input.palletTotal);
    const pallets = fromPallets === toPallets ? null : {fromQuantity:fromPallets,toQuantity:toPallets,
      rate:normalizeSpecialRate(detail.palletRate ?? (toPallets ? input.palletRate : 0))};
    if (!changes.length && !pallets) throw workflowError('Change a quantity, discount or PALLET quantity before submitting.',400,'SPECIAL_QUANTITY_UNCHANGED');
    const review = newQuantityReview(changes,'issued',context.operatorId);
    if (pallets) review.pallets = pallets;
    if (pallets || changes.some(change=>change.fromDiscountPercent!==change.toDiscountPercent || change.toNativeDiscountPercent>0)
      || detail.salesOrderLines.some(line=>line.nativeDiscountPercent>0)) review.adjustmentVersion = 2;
    await writeQuantityReview(id,review);
    await bumpCase(id);
    await appendEvent(id,'special_quantity_review_requested',context.operatorId,{reviewId:review.id,mode:review.mode,lines:changes});
  });
  return getSpecialStockCase(id,{audience:'sales',authorizedStoreLocationIds:context.authorizedStoreLocationIds});
}

export async function withSpecialQuantityReviewLock(requestId, run) {
  const client = await pool.connect();
  const key = `special-quantity-review:${positiveId(requestId,'Special Item case')}`;
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
    if (!locked) throw workflowError('SCM quantity confirmation is already running.',409,'SPECIAL_QUANTITY_REVIEW_BUSY');
    return await run();
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>null);
    client.release();
  }
}

export async function claimSpecialQuantityReview(requestId,input,context={}) {
  const id = positiveId(requestId,'Special Item case');
  await withTransaction(async()=>{
    const special = await lockCase(id,input.expectedRevision);
    const review = matchingQuantityReview(special,input.reviewId);
    if (review.status==='approved') return;
    if (!quantityReviewPending(review)) throw workflowError('There is no pending quantity review.',409,'SPECIAL_QUANTITY_REVIEW_STALE');
    if ([special.sales_order_operation_status,special.purchase_order_operation_status].some(status=>['creating','attention'].includes(status))) throw workflowError('Resolve the existing order operation first.',409,'SPECIAL_OPERATION_BUSY');
    await assertQuantityActionAllowed(await selectCaseRow(id));
    await writeQuantityReview(id,{...review,status:'applying',confirmedBy:context.operatorId,confirmedAt:review.confirmedAt||new Date().toISOString(),error:null});
    await bumpCase(id);
    await appendEvent(id,'special_quantity_review_confirmed',context.operatorId,{reviewId:review.id});
  });
  return getSpecialStockCase(id,{audience:'scm'});
}

export async function saveSpecialQuantityReviewPlan(requestId,{reviewId,plan,remoteStarted=false}) {
  await withTransaction(async()=>{
    const special = await selectCaseRow(requestId,{forUpdate:true});
    const review = matchingQuantityReview(special,reviewId);
    if (review.status!=='applying') throw workflowError('The quantity review is not being applied.',409,'SPECIAL_QUANTITY_REVIEW_STALE');
    if (review.plan && plan && JSON.stringify(review.plan)!==JSON.stringify(plan)) throw workflowError('The verified order plan cannot be replaced.',409,'SPECIAL_QUANTITY_REVIEW_STALE');
    await writeQuantityReview(requestId,{...review,plan:review.plan||plan,remoteStarted:review.remoteStarted||remoteStarted});
  });
}

async function updateReviewedQuantities(id,changes,{reject=false,issued=false}={}) {
  for (const change of changes) {
    const quantity=reject?change.fromQuantity:change.toQuantity;
    const purchaseQuantity=reject?change.fromPurchaseQuantity:change.toPurchaseQuantity;
    const packageQuantity=reject?change.fromPackageQuantity:change.toPackageQuantity;
    const conversion=reject?change.fromConversion:change.toConversion;
    if (reject && issued) continue;
    const priced=(await query('SELECT original_unit_rate,discount_percent FROM sales_special_stock_lines WHERE request_id=$1 AND id=$2',[id,change.caseLineId])).rows[0];
    const so=(await query("SELECT native_discount_percent FROM sales_special_stock_order_lines WHERE request_id=$1 AND case_line_id=$2 AND order_kind='sales_order'",[id,change.caseLineId])).rows[0];
    const discount=reject ? change.fromDiscountPercent ?? Number(priced.discount_percent) : change.toDiscountPercent ?? Number(priced.discount_percent);
    const native=reject ? change.fromNativeDiscountPercent ?? so?.native_discount_percent : change.toNativeDiscountPercent ?? so?.native_discount_percent;
    const rate=(native != null ? specialNativeLinePricing : specialNativePricing)({quantity:packageQuantity,rate:priced.original_unit_rate,discountPercent:discount,conversionToPc:conversion}).rate;
    await query(`UPDATE sales_special_stock_lines SET sales_package_quantity=$3,pieces_per_unit=$4,
      sales_quantity=$5,purchase_quantity=$6,scm_reviewed_quantity=$3,scm_reviewed_pieces_per_unit=$4,discount_percent=$7,updated_at=now()
      WHERE request_id=$1 AND id=$2`,[id,change.caseLineId,packageQuantity,conversion,quantity,purchaseQuantity,discount]);
    await query(`UPDATE sales_special_stock_order_lines SET quantity=CASE WHEN order_kind='sales_order' THEN $3::numeric ELSE $4::numeric END,
      unit_rate=CASE WHEN order_kind='sales_order' THEN $5::numeric ELSE unit_rate END,
      native_discount_percent=CASE WHEN order_kind='sales_order' THEN $6::numeric ELSE NULL END,updated_at=now()
      WHERE request_id=$1 AND case_line_id=$2`,[id,change.caseLineId,quantity,purchaseQuantity,rate,native == null ? null : discount]);
  }
}

async function updateReviewedPallets(id, special, review, verifiedOrders) {
  const remote=verifiedOrders.find(order=>order.kind==='sales_order' && order.id===Number(special.sales_order_netsuite_id));
  const pallet=remote?.lines.find(line=>line.itemId===1784);
  const salesPlan=review.plan?.transport==='restRecord' ? review.plan.orders.find(order=>order.kind==='sales_order' && order.id===Number(special.sales_order_netsuite_id)) : null;
  const targetPallet=salesPlan?.target.lines.find(line=>line.itemId===1784);
  const repositioned=targetPallet?.remoteLineId===null && salesPlan?.baseline.lines.some(line=>line.itemId===1784);
  const proposal=review.pallets || (repositioned ? {toQuantity:targetPallet.quantity,rate:Number(targetPallet.rate)} : null);
  if (!proposal) return;
  const {toQuantity,rate}=proposal;
  const before=(await query("SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 AND order_kind='sales_order' AND item_id=1784 FOR UPDATE",[id])).rows;
  if (before.length>1 || (special.sales_order_netsuite_id && (toQuantity>0 ? !pallet || pallet.quantity!==toQuantity || Number(pallet.rate)!==rate : Boolean(pallet)))
    || (!review.pallets && (before.length!==1 || Number(before[0].quantity)!==toQuantity || Number(before[0].unit_rate)!==rate))) {
    throw workflowError('The reviewed PALLET line has not been verified.',409,'SPECIAL_QUANTITY_NOT_VERIFIED');
  }
  if (!toQuantity) {
    await query("DELETE FROM sales_special_stock_order_lines WHERE request_id=$1 AND order_kind='sales_order' AND item_id=1784",[id]);
    if (before[0]?.remote_line_id) await query('UPDATE sales_order_lines SET netsuite_active=false WHERE sales_order_id=$1 AND line_id=$2',[special.sales_order_netsuite_id,before[0].remote_line_id]);
  } else if (before.length) {
    await query('UPDATE sales_special_stock_order_lines SET quantity=$2,remote_line_id=COALESCE($3,remote_line_id),updated_at=now() WHERE id=$1',[before[0].id,toQuantity,pallet?.remoteLineId]);
    if (pallet && before[0].remote_line_id && Number(before[0].remote_line_id)!==pallet.remoteLineId) {
      await query('UPDATE sales_order_lines SET netsuite_active=false WHERE sales_order_id=$1 AND line_id=$2',[special.sales_order_netsuite_id,before[0].remote_line_id]);
    }
  } else {
    const item=(await query('SELECT item_name FROM inventory_items WHERE item_id=1784')).rows[0];
    if (!item) throw workflowError('PALLET is missing from the synced item master.',409,'SPECIAL_SO_ITEM_NOT_FOUND');
    await query(`INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_rate,remote_line_id)
      VALUES($1,'sales_order',true,1784,$2,'PALLET',$3,'EACH',$4,$5)`,[id,item.item_name,toQuantity,rate,pallet?.remoteLineId]);
  }
  if (pallet) await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active)
    VALUES($1,$2,1784,'PALLET',$3,$4,'EACH',true) ON CONFLICT(sales_order_id,line_id)
    DO UPDATE SET quantity=EXCLUDED.quantity,netsuite_active=true`,[special.sales_order_netsuite_id,pallet.remoteLineId,pallet.description,toQuantity]);
  await query('UPDATE sales_special_stock_cases SET pallet_total=$2,pallet_rate=COALESCE(pallet_rate,$3) WHERE request_id=$1',[id,toQuantity,rate]);
}

export async function finishSpecialQuantityReview(requestId,{reviewId,verifiedOrderIds=[],verifiedOrders=[]},context={}) {
  const id=positiveId(requestId,'Special Item case');
  await withTransaction(async()=>{
    const special=await selectCaseRow(id,{forUpdate:true});
    const review=matchingQuantityReview(special,reviewId);
    if (review.status==='approved') return;
    if (review.status!=='applying') throw workflowError('SCM confirmation is required.',409,'SPECIAL_QUANTITY_REVIEW_STALE');
    await assertQuantityActionAllowed(await selectCaseRow(id));
    const remoteIds=[special.sales_order_netsuite_id,special.purchase_order_netsuite_id].filter(Boolean).map(Number);
    if (remoteIds.some(orderId=>!verifiedOrderIds.includes(orderId)) || (remoteIds.length && !review.plan)) throw workflowError('Both issued orders must be verified before completing the change.',409,'SPECIAL_QUANTITY_NOT_VERIFIED');
    await updateReviewedQuantities(id,review.lines);
    if (special.vendor_discount_review?.mode === 'per_line') {
      const saved=special.vendor_discount_review;
      const updated=refreshSpecialVendorDiscountReview(saved.lines.map(line=>{
        const change=review.lines.find(change=>Number(change.caseLineId)===Number(line.caseLineId));
        return {...line,quantity:change ? change.toPurchaseQuantity : line.quantity};
      }),saved);
      await query('UPDATE sales_special_stock_cases SET vendor_discount_review=$2::jsonb WHERE request_id=$1',
        [id,JSON.stringify({...saved,...updated})]);
    }
    await updateReviewedPallets(id,special,review,verifiedOrders);
    for (const order of review.plan?.orders || []) {
      const sales=order.kind==='sales_order';
      for (const change of order.changes || []) await query(`UPDATE ${sales?'sales_order_lines':'purchase_order_lines'} SET quantity=$3
        WHERE ${sales?'sales_order_id':'purchase_order_id'}=$1 AND line_id=$2`,[order.id,change.remoteLineId,change.toQuantity]);
      if (review.plan.version===2) for (const line of order.target.lines.filter(line=>line.remoteLineId && line.itemId!==10716)) {
        await query(`UPDATE ${sales?'sales_order_lines':'purchase_order_lines'} SET quantity=$3
          WHERE ${sales?'sales_order_id':'purchase_order_id'}=$1 AND line_id=$2`,[order.id,line.remoteLineId,line.quantity]);
      }
    }
    await writeQuantityReview(id,{...review,status:'approved',completedAt:new Date().toISOString(),error:null});
    if (review.mode === 'issued' && special.sales_order_netsuite_id && special.purchase_order_netsuite_id
      && (review.pallets || review.lines.some(line=>line.fromQuantity!==line.toQuantity))) {
      await query(`UPDATE dispatch_so_po_allocations SET status='cancelled',cancelled_by=$3,cancelled_at=now(),updated_at=now()
        WHERE sales_order_id=$1 AND po_order_id=$2 AND status='active'`,[special.sales_order_netsuite_id,special.purchase_order_netsuite_id,context.operatorId||null]);
      await query("UPDATE sales_special_stock_handoffs SET route=NULL,route_selected_at=NULL,route_selected_by=NULL,status='waiting_route',updated_at=now() WHERE request_id=$1",[id]);
      await query("UPDATE sales_special_stock_cases SET handoff_route='none' WHERE request_id=$1",[id]);
    }
    await query('UPDATE sales_special_stock_cases SET attention=false,attention_reason=NULL WHERE request_id=$1',[id]);
    const current=await selectCaseRow(id);
    await upsertHandoff(id,current);
    await bumpCase(id);
    await appendEvent(id,'special_quantity_review_approved',context.operatorId,{reviewId,lines:review.lines,verifiedOrderIds});
  });
  return getSpecialStockCase(id,{audience:'scm'});
}

export async function rejectSpecialQuantityReview(requestId,input,context={}) {
  const id=positiveId(requestId,'Special Item case');
  await withTransaction(async()=>{
    const special=await lockCase(id,input.expectedRevision);
    const review=matchingQuantityReview(special,input.reviewId);
    if (!['pending','attention'].includes(review.status) || review.remoteStarted) throw workflowError('An order update has started. Recover it before changing the proposal.',409,'SPECIAL_QUANTITY_REVIEW_BUSY');
    await updateReviewedQuantities(id,review.lines,{reject:true,issued:review.mode==='issued'});
    await writeQuantityReview(id,{...review,status:'rejected',reason:cleanSearch(input.reason,2000),reviewedBy:context.operatorId,completedAt:new Date().toISOString()});
    await bumpCase(id);
    await appendEvent(id,'special_quantity_review_rejected',context.operatorId,{reviewId:review.id,reason:cleanSearch(input.reason,2000)});
  });
  return getSpecialStockCase(id,{audience:'scm'});
}

export async function failSpecialQuantityReview(requestId,{reviewId,errorMessage},context={}) {
  await withTransaction(async()=>{
    const special=await selectCaseRow(requestId,{forUpdate:true});
    const review=matchingQuantityReview(special,reviewId);
    if (review.status!=='applying') return;
    const message=cleanSearch(errorMessage,2000);
    await writeQuantityReview(requestId,{...review,status:'attention',error:message});
    await bumpCase(requestId);
    await appendEvent(requestId,'special_quantity_review_attention',context.operatorId,{reviewId,error:message});
  });
}

export async function updateSpecialPurchaseReference(requestId, input = {}, context = {}) {
  const id = positiveId(requestId, 'Special Item case');
  for (const key of ['reference','previousReference']) {
    if (typeof input[key] !== 'string' || input[key].length > 120 || /[\u0000-\u001f\u007f]/.test(input[key])) {
      throw workflowError('PO reference must be text of 120 characters or fewer.',400,'SPECIAL_PO_REFERENCE_INVALID');
    }
  }
  await withTransaction(async () => {
    let special = await lockCase(id,input.expectedRevision);
    assertCaseEditable(special);
    if (special.close_status !== 'active' || special.operationally_complete) throw workflowError('This request is no longer editable.',409,'SPECIAL_CASE_CLOSED');
    const po = (await query('SELECT netsuite_id,tranid,dispatch_ref FROM purchase_orders WHERE netsuite_id=$1 FOR UPDATE',[special.purchase_order_netsuite_id])).rows[0];
    special = await selectCaseRow(id);
    await assertPurchaseApproved(special);
    if (!po || String(po.dispatch_ref || '') !== input.previousReference) throw workflowError('The PO reference changed. Refresh before saving.',409,'SPECIAL_PO_REFERENCE_CONFLICT');
    const saved = await updatePurchaseOrderDispatchRef({poRef:po.dispatch_ref || po.tranid,newRef:input.reference.trim(),updatedBy:context.operatorId});
    if (Number(saved.poId) !== Number(po.netsuite_id)) throw workflowError('The PO reference is ambiguous.',409,'SPECIAL_PO_REFERENCE_CONFLICT');
    await appendEvent(id,'special_purchase_reference_updated',context.operatorId,{before:po.dispatch_ref || '',reference:saved.dispatchRef},{audience:'scm'});
    await bumpCase(id);
  });
  return getSpecialStockCase(id,{audience:'scm'});
}

async function assertFulfillmentUnplanned(special) {
  const detail = mapCase(special);
  const planning = specialDispatchPlanning(detail,await readSpecialDispatchPlans());
  const handoff = (await query('SELECT status FROM sales_special_stock_handoffs WHERE request_id=$1',[special.request_id])).rows[0];
  if (planning.anyPlanned || detail.dispatchPlanned || ['planned','in_progress','completed'].includes(handoff?.status)) {
    throw workflowError('Delivery method is locked once the SO or PO is planned.',409,'SPECIAL_FULFILLMENT_PLANNED');
  }
  if (special.close_status !== 'active' || detail.operationallyComplete || special.canonical_sales_fulfilled_at || special.canonical_purchase_received_at
      || terminalSalesOrder(special) || terminalPurchaseOrder(special)) {
    throw workflowError('Delivery method cannot change after fulfillment or closure.',409,'SPECIAL_FULFILLMENT_CLOSED');
  }
}

/** @param {number|string} requestId @param {Record<string,any>} input @param {{operatorId?:string|null,authorizedStoreLocationIds?:number[]}} context */
export async function updateSpecialStockHeader(requestId, input = {}, { operatorId, authorizedStoreLocationIds = [] } = {}) {
  const id = positiveId(requestId, 'Special Item case'), actorId = String(operatorId || '').trim();
  if (!actorId) throw workflowError('An authenticated Sales operator is required.', 401, 'SPECIAL_ACTOR_REQUIRED');
  const remarks = normalizeSpecialHeaderNote(input.remarks);
  const internalRemark = Object.hasOwn(input, 'salesInternalRemark') ? normalizeSpecialSalesInternalRemark(input.salesInternalRemark) : undefined;
  await withTransaction(async () => {
    const special = await lockCase(id, input.expectedRevision), detail = /** @type {Record<string,any>} */ (mapCase(special));
    assertScope(detail, authorizedStoreLocationIds);
    if (!canEditSpecialHeader(detail)) throw workflowError('Header editing is available on active requests before Sales Order creation. Resolve pending operations first.', 409, 'SPECIAL_HEADER_LOCKED');
    await assertFulfillmentUnplanned(special);
    const target = /** @type {Record<string,any>} */ (normalizeSpecialFulfillment({ ...detail, ...input }));
    const previous = Object.fromEntries(Object.keys(target).map(field => [field, detail[field]]));
    const deliveryChanged = Object.entries(target).some(([field, value]) => String(value ?? '') !== String(detail[field] ?? ''));
    const internalChanged = internalRemark !== undefined && internalRemark !== detail.salesInternalRemark;
    if (!deliveryChanged && remarks === detail.remarks && !internalChanged) return;
    if (deliveryChanged) {
      if (target.fulfillmentMethod === 'mbt_delivery') assertSpecialDeliveryDate(target.deliveryDate);
      await query(`UPDATE sales_special_stock_cases SET fulfillment_method=$2,delivery_address=$3,delivery_contact_name=$4,delivery_contact_phone=$5,
        delivery_date=$6,delivery_window_start=$7,delivery_window_end=$8,delivery_instructions=$9,updated_at=now() WHERE request_id=$1`,
      [id,target.fulfillmentMethod,target.deliveryAddress,target.deliveryContactName,target.deliveryContactPhone,target.deliveryDate,target.windowStart,target.windowEnd,target.deliveryInstructions]);
    }
    await query('UPDATE sales_stock_requests SET remarks=$2, revision=revision+1, updated_at=now() WHERE id=$1', [id, remarks]);
    if (internalChanged) await saveSalesInternalRemark(id, internalRemark, detail.salesInternalRemark, actorId);
    if (deliveryChanged || remarks !== detail.remarks) await appendEvent(id, 'special_case_header_updated', actorId, {
      before: { ...previous, remarks: detail.remarks }, after: { ...target, remarks }
    });
  });
  return getSpecialStockCase(id, { audience: 'sales', authorizedStoreLocationIds });
}

/** @param {number} id @param {string} value @param {string} previous @param {string} actorId */
async function saveSalesInternalRemark(id, value, previous, actorId) {
  await query('UPDATE sales_special_stock_cases SET sales_internal_remark=$2,updated_at=now() WHERE request_id=$1', [id, value]);
  await appendEvent(id, 'special_sales_internal_remark_updated', actorId,
    { before: { salesInternalRemark: previous }, after: { salesInternalRemark: value } }, { audience: 'sales' });
}

/** @param {number|string} requestId @param {Record<string,any>} input @param {{operatorId?:string|null,authorizedStoreLocationIds?:number[]}} context */
export async function updateSpecialSalesInternalRemark(requestId, input = {}, { operatorId, authorizedStoreLocationIds = [] } = {}) {
  const id = positiveId(requestId, 'Special Item case'), actorId = String(operatorId || '').trim();
  if (!actorId) throw workflowError('An authenticated Sales operator is required.', 401, 'SPECIAL_ACTOR_REQUIRED');
  const value = normalizeSpecialSalesInternalRemark(input.salesInternalRemark);
  await withTransaction(async () => {
    const detail = mapCase(await lockCase(id, input.expectedRevision));
    assertScope(detail, authorizedStoreLocationIds);
    if (!canEditSpecialSalesInternalRemark(detail)) throw workflowError('Sales internal remarks can only be edited while the request is active.', 409, 'SPECIAL_SALES_INTERNAL_REMARK_LOCKED');
    if (value === detail.salesInternalRemark) return;
    await saveSalesInternalRemark(id, value, detail.salesInternalRemark, actorId);
    await query('UPDATE sales_stock_requests SET revision=revision+1,updated_at=now() WHERE id=$1', [id]);
  });
  return getSpecialStockCase(id, { audience: 'sales', authorizedStoreLocationIds });
}

export async function claimSpecialFulfillmentChange(requestId,input={},context={}) {
  const id=positiveId(requestId,'Special Item case');
  await withTransaction(async()=>{
    const special=await lockCase(id,input.expectedRevision);
    assertScope(mapCase(special),context.authorizedStoreLocationIds);
    await assertFulfillmentUnplanned(special);
    const previous=special.fulfillment_change;
    if (input.changeId && previous?.id===input.changeId && ['applying','attention','complete'].includes(previous.status)) return;
    assertCaseEditable(special); assertNoSpecialQuantityReview(special);
    if (special.attention || special.post_po_change_pending) throw workflowError('Resolve this request’s Attention state first.',409,'SPECIAL_FULFILLMENT_ATTENTION');
    const target=normalizeSpecialFulfillment(input);
    if (target.fulfillmentMethod==='mbt_delivery' && !special.sales_order_netsuite_id) assertSpecialDeliveryDate(target.deliveryDate);
    const journal={id:crypto.randomUUID(),status:'applying',target,requestedBy:context.operatorId,requestedAt:new Date().toISOString()};
    await query('UPDATE sales_special_stock_cases SET fulfillment_change=$2::jsonb,updated_at=now() WHERE request_id=$1',[id,JSON.stringify(journal)]);
    await appendEvent(id,'special_delivery_change_started',context.operatorId,{changeId:journal.id,target});await bumpCase(id);
  });
  return getSpecialStockCase(id,{audience:'scm'});
}

async function ownedFulfillmentChange(requestId,changeId) {
  const special=await selectCaseRow(requestId,{forUpdate:true});
  if (special.fulfillment_change?.id!==changeId || !['applying','attention'].includes(special.fulfillment_change.status)) {
    throw workflowError('This delivery update is no longer active.',409,'SPECIAL_FULFILLMENT_STALE');
  }
  return special;
}

export async function saveSpecialFulfillmentPlan(requestId,changeId,plan) {
  await withTransaction(async()=>{
    const special=await ownedFulfillmentChange(requestId,changeId);
    await query('UPDATE sales_special_stock_cases SET fulfillment_change=$2::jsonb WHERE request_id=$1',
      [requestId,JSON.stringify({...special.fulfillment_change,plan,status:'applying',error:null})]);
  });
}

export async function failSpecialFulfillmentChange(requestId,changeId,message,context={}) {
  await withTransaction(async()=>{
    const special=await ownedFulfillmentChange(requestId,changeId);
    await query('UPDATE sales_special_stock_cases SET fulfillment_change=$2::jsonb WHERE request_id=$1',
      [requestId,JSON.stringify({...special.fulfillment_change,status:'attention',error:cleanSearch(message,2000)})]);
    await appendEvent(requestId,'special_delivery_change_attention',context.operatorId,{changeId,error:cleanSearch(message,2000)});await bumpCase(requestId);
  });
}

export async function finishSpecialFulfillmentChange(requestId,changeId,{deliveryMethodId=null}={},context={}) {
  await withTransaction(async()=>{
    const special=await ownedFulfillmentChange(requestId,changeId),change=special.fulfillment_change,target=change.target;
    await assertFulfillmentUnplanned(special);
    const localPickup=isLocalPickupChange(special.fulfillment_method,target.fulfillmentMethod,change.plan);
    if (special.sales_order_netsuite_id && !localPickup && (!change.plan || Number(change.plan.target.methodId)!==Number(deliveryMethodId))) {
      throw workflowError('The saved SO delivery update must be verified first.',409,'SPECIAL_FULFILLMENT_UNVERIFIED');
    }
    await query(`UPDATE sales_special_stock_cases SET fulfillment_method=$2,delivery_address=$3,delivery_contact_name=$4,delivery_contact_phone=$5,
      delivery_date=$6,delivery_window_start=$7,delivery_window_end=$8,delivery_instructions=$9,fulfillment_change=$10::jsonb,
      operational_yard_location_id=COALESCE(operational_yard_location_id,$11),handoff_route='none',updated_at=now() WHERE request_id=$1`,
    [requestId,target.fulfillmentMethod,target.deliveryAddress,target.deliveryContactName,target.deliveryContactPhone,target.deliveryDate,target.windowStart,target.windowEnd,target.deliveryInstructions,
      JSON.stringify({...change,status:'complete',completedAt:new Date().toISOString(),error:null}),special.destination_location_id]);
    if (special.sales_order_netsuite_id) {
      if (!localPickup) {
        const delivery=target.fulfillmentMethod==='mbt_delivery';
        const instructions=[target.deliveryInstructions,target.deliveryContactName || target.deliveryContactPhone ? `Contact: ${target.deliveryContactName || ''} ${target.deliveryContactPhone || ''}`:null].filter(Boolean).join('\n');
        await query(`UPDATE sales_orders SET delivery_method_id=$2,sales_order_type=$3,expected_delivery_date=$4,dispatch_address=$5,
          dispatch_window_start=$6,dispatch_window_end=$7,dispatch_instructions=$8,dispatch_parse_source='manual-dispatch-details',dispatch_parsed_at=now() WHERE netsuite_id=$1`,
        [special.sales_order_netsuite_id,deliveryMethodId,delivery?'Delivery':'Pickup',target.deliveryDate,target.deliveryAddress,target.windowStart,target.windowEnd,instructions]);
        await query(`INSERT INTO sales_order_delivery_instructions(sales_order_id,additional_text,revision,created_by,created_source,updated_by,updated_source)
          VALUES($1,$2,1,$3,'sales',$3,'sales') ON CONFLICT(sales_order_id) DO UPDATE SET additional_text=EXCLUDED.additional_text,
            revision=sales_order_delivery_instructions.revision+1,updated_by=EXCLUDED.updated_by,updated_source='sales',updated_at=now()`,
        [special.sales_order_netsuite_id,instructions,context.operatorId]);
      }
      await query(`UPDATE dispatch_so_po_allocations SET status='cancelled',cancelled_by=$3,cancelled_at=now(),updated_at=now()
        WHERE sales_order_id=$1 AND po_order_id=$2 AND status='active'`,[special.sales_order_netsuite_id,special.purchase_order_netsuite_id,context.operatorId||null]);
    }
    await query("DELETE FROM sales_special_stock_handoffs WHERE request_id=$1 AND status NOT IN ('planned','in_progress','completed')",[requestId]);
    await upsertHandoff(requestId,await selectCaseRow(requestId));
    await appendEvent(requestId,'special_delivery_method_updated',context.operatorId,{changeId,before:special.fulfillment_method,...target});await bumpCase(requestId);
  });
  return getSpecialStockCase(requestId,{audience:'sales',authorizedStoreLocationIds:context.authorizedStoreLocationIds});
}

// Options come from stored cases so free-text vendor names remain filterable.
export async function listSpecialCaseVendors({authorizedStoreLocationIds, requestedByOperatorId} = {}) {
  const {rows} = await query(`SELECT DISTINCT special.vendor_name
    FROM sales_special_stock_cases special JOIN sales_stock_requests request ON request.id=special.request_id
    WHERE ($1::bigint[] IS NULL OR request.destination_location_id=ANY($1::bigint[]))
      AND ($2::text IS NULL OR request.requested_by=$2) AND btrim(special.vendor_name)<>''
    ORDER BY special.vendor_name`, [authorizedStoreLocationIds ?? null, requestedByOperatorId || null]);
  return rows.map(row=>row.vendor_name);
}

export async function updateSpecialCaseExpiry(requestId, input, context) {
  const id = positiveId(requestId, 'Special Item case');
  const expiresOn = normalizeSpecialExpiry(input.expiresOn);
  await withTransaction(async()=>{
    const special = await lockCase(id, input.expectedRevision);
    assertScope(mapCase(special), context.authorizedStoreLocationIds);
    if (special.close_status !== 'active' || special.sales_order_netsuite_id || special.purchase_order_netsuite_id
        || special.sales_order_skipped || special.purchase_order_skipped || special.operationally_complete) {
      throw workflowError('Expiry can only change on an active request without orders.',409,'SPECIAL_EXPIRY_LOCKED');
    }
    assertCaseEditable(special);
    await query('UPDATE sales_special_stock_cases SET expires_on=$2,updated_at=now() WHERE request_id=$1',[id,expiresOn]);
    await bumpCase(id);
    await appendEvent(id,'special_expiry_updated',context.operatorId,{from:dateValue(special.expires_on),to:expiresOn});
  });
  return getSpecialStockCase(id,{audience:'sales',authorizedStoreLocationIds:context.authorizedStoreLocationIds});
}

export async function expireSpecialStockCases({today=torontoDate(),limit=100} = {}) {
  normalizeSpecialExpiry(today,today);
  return withTransaction(async()=>{
    // The same request/case locks protect order claims and expiry changes. Another
    // worker skips owned rows, and a pending remote submission is never closed.
    const {rows} = await query(`SELECT special.request_id,special.expires_on
      FROM sales_special_stock_cases special JOIN sales_stock_requests request ON request.id=special.request_id
      WHERE special.expires_on < $1::date AND special.close_status='active'
        AND request.status <> 'cancelled'
        AND special.sales_order_netsuite_id IS NULL AND special.purchase_order_netsuite_id IS NULL
        AND NOT special.sales_order_skipped AND NOT special.purchase_order_skipped
        AND NOT special.attention AND NOT special.operationally_complete AND NOT special.post_po_change_pending
        AND special.sales_order_operation_status='idle' AND special.purchase_order_operation_status='idle'
        AND special.sales_order_submission_started_at IS NULL AND special.purchase_order_submission_started_at IS NULL
        AND COALESCE(special.quantity_review->>'status','') NOT IN ('pending','applying','attention')
        AND COALESCE(special.fulfillment_change->>'status','') NOT IN ('pending','applying','attention')
        AND COALESCE(special.closure_review->>'status','') NOT IN ('pending','applying','attention')
        AND NOT EXISTS(SELECT 1 FROM sales_special_stock_handoffs h WHERE h.request_id=special.request_id AND h.status IN ('planned','in_progress','completed'))
        AND EXISTS(SELECT 1 FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow' AND enabled)
      ORDER BY special.request_id LIMIT $2 FOR UPDATE OF request,special SKIP LOCKED`,[today,Math.min(100,optionalLimit(limit))]);
    for (const row of rows) {
      const id=Number(row.request_id),expiresOn=dateValue(row.expires_on);
      await query(`UPDATE sales_special_stock_cases SET close_status='closed',closure_reason=$2,
        closure_requested_by=NULL,closure_requested_at=now(),closed_at=now(),updated_at=now() WHERE request_id=$1`,[id,`Expired after ${expiresOn}`]);
      await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1",[id]);
      await bumpCase(id);
      await appendEvent(id,'special_case_expired',null,{expiresOn,source:'automatic_expiry'});
    }
    return rows.map(row=>Number(row.request_id));
  });
}
