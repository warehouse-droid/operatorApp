import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { getSmartScmProposal } from "./smart-scm-planning-repository.js";
import { resolveSmartScmVendorItemCodes } from "./smart-scm-vendor-code-service.js";
import { smartScmVendorFinancialLine } from "./smart-scm-vendor-financials.js";
import { overlaySmartScmVendorPoFinancials } from "./smart-scm-vendor-po-financials.js";

const WORKFLOW_KINDS = new Set(["regular_po", "blanket_po"]);
const EMAIL_TO_LIMIT = 1000;
const EMAIL_SUBJECT_LIMIT = 300;
const EMAIL_BODY_LIMIT = 4000;
const VENDOR_CODE_LIMIT = 200;

function text(value) {
  return String(value ?? "").trim();
}

function limitedText(value, limit, label) {
  const normalized = text(value);
  if (normalized.length > limit) {
    throw Object.assign(new Error(`${label} cannot exceed ${limit} characters.`), { status: 400 });
  }
  return normalized;
}

function positive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((Number(value || 0) + Number.EPSILON) * factor) / factor;
}

function workflowKindForProposal(row = {}) {
  return text(row.proposal_origin) === "blanket" ? "blanket_po" : "regular_po";
}

function workflowKey(kind, sourceProposalId) {
  return `${kind === "blanket_po" ? "blanket-proposal" : "proposal"}:${Number(sourceProposalId)}`;
}

function publicWorkflowRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    workflowKey: row.workflow_key,
    workflowKind: row.workflow_kind,
    sourceProposalId: Number(row.source_proposal_id),
    reviewProposalId: row.review_proposal_id === null ? null : Number(row.review_proposal_id),
    sourcePurchaseOrderId: row.source_purchase_order_id === null ? null : Number(row.source_purchase_order_id),
    sourcePurchaseOrderRef: row.source_purchase_order_ref || "",
    workflowStatus: row.workflow_status,
    emailTo: row.email_to || "",
    emailSubject: row.email_subject || "",
    emailIntro: row.email_intro || "",
    emailClosing: row.email_closing || "",
    vendorCodeOverrides: row.vendor_code_overrides || {},
    emailUpdatedAt: row.email_updated_at || null,
    emailUpdatedBy: row.email_updated_by || null,
    netsuitePurchaseOrderId: row.netsuite_purchase_order_id === null ? null : Number(row.netsuite_purchase_order_id),
    netsuitePurchaseOrderRef: row.netsuite_purchase_order_ref || "",
    splitId: row.split_id === null ? null : Number(row.split_id),
    splitPurchaseOrderId: row.split_purchase_order_id === null ? null : Number(row.split_purchase_order_id),
    splitPurchaseOrderRef: row.split_purchase_order_ref || "",
    archivedAt: row.archived_at || null,
    archivedBy: row.archived_by || null,
    archiveReason: row.archive_reason || null,
    version: Number(row.version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function vendorCodeOverrides(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Vendor-code overrides must be an object keyed by NetSuite item ID."), { status: 400 });
  }
  const normalized = {};
  for (const [rawItemId, rawCode] of Object.entries(value)) {
    const itemId = Number(rawItemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      throw Object.assign(new Error("Every vendor-code override needs a valid NetSuite item ID."), { status: 400 });
    }
    normalized[String(itemId)] = limitedText(rawCode, VENDOR_CODE_LIMIT, "Vendor item code");
  }
  return normalized;
}

export function groupSmartScmVendorEmailRows(lines = [], metadataByItem = new Map(), overrides = {}) {
  const metadata = metadataByItem instanceof Map
    ? metadataByItem
    : new Map(Object.entries(metadataByItem || {}).map(([itemId, value]) => [Number(itemId), value]));
  const grouped = new Map();
  for (const line of lines || []) {
    const itemId = Number(line.itemId ?? line.item_id);
    const itemName = text(line.itemName ?? line.item_name);
    if (line.ancillaryPallet === true || itemName.toUpperCase() === "PALLET") continue;
    const key = Number.isInteger(itemId) && itemId > 0
      ? String(itemId)
      : `line:${line.id ?? grouped.size}:${itemName.toUpperCase()}`;
    const itemMeta = metadata.get(itemId) || {};
    const current = grouped.get(key) || {
      itemId: Number.isInteger(itemId) && itemId > 0 ? itemId : null,
      itemName: itemName || text(itemMeta.itemName ?? itemMeta.item_name) || `Item ${itemId || ""}`.trim(),
      vendorCode: text(overrides[String(itemId)] ?? line.vendorCode ?? itemMeta.vendorCode ?? itemMeta.vendor_code),
      description: text(line.itemDescription ?? line.item_description ?? itemMeta.description ?? itemMeta.item_description),
      requestedPallets: 0,
      destinationCount: 0,
      destinationLocationIds: []
    };
    current.requestedPallets = round(current.requestedPallets + positive(
      line.proposedPallets ?? line.proposed_pallets ?? line.requestedPallets
    ));
    const destinationLocationId = Number(line.destinationLocationId ?? line.destination_location_id);
    if (Number.isInteger(destinationLocationId) && !current.destinationLocationIds.includes(destinationLocationId)) {
      current.destinationLocationIds.push(destinationLocationId);
      current.destinationCount = current.destinationLocationIds.length;
    }
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map((row) => ({
      ...row,
      vendorCodeMissing: !row.vendorCode
    }))
    .sort((left, right) => left.itemName.localeCompare(right.itemName, "en", { numeric: true })
      || Number(left.itemId || 0) - Number(right.itemId || 0));
}

async function latestReviewBySource() {
  return query(
    `SELECT DISTINCT ON (parent_proposal_id)
            id, parent_proposal_id, status, netsuite_purchase_order_id,
            netsuite_purchase_order_ref, updated_at
       FROM scm_smart_proposals
      WHERE proposal_type = 'PO'
        AND vendor_resolution_kind = 'netsuite_po_review'
        AND parent_proposal_id IS NOT NULL
      ORDER BY parent_proposal_id, id DESC`
  );
}

export async function backfillSmartScmVendorWorkflows() {
  await query(
    `WITH latest_review AS (
       SELECT DISTINCT ON (parent_proposal_id)
              id, parent_proposal_id, status, netsuite_purchase_order_id,
              netsuite_purchase_order_ref, updated_at
         FROM scm_smart_proposals
        WHERE proposal_type = 'PO'
          AND vendor_resolution_kind = 'netsuite_po_review'
          AND parent_proposal_id IS NOT NULL
        ORDER BY parent_proposal_id, id DESC
     )
     INSERT INTO scm_smart_vendor_workflows (
       workflow_key, workflow_kind, source_proposal_id, review_proposal_id,
       source_purchase_order_id, source_purchase_order_ref, workflow_status,
       netsuite_purchase_order_id, netsuite_purchase_order_ref,
       archived_at, archived_by, archive_reason, created_at, updated_at
     )
     SELECT CASE WHEN source.proposal_origin = 'blanket'
                   THEN 'blanket-proposal:' || source.id
                   ELSE 'proposal:' || source.id
            END,
            CASE WHEN source.proposal_origin = 'blanket' THEN 'blanket_po' ELSE 'regular_po' END,
            source.id,
            review.id,
            source.blanket_source_po_id,
            source.blanket_source_po_ref,
            CASE
              WHEN source.proposal_origin = 'blanket' AND source.status = 'completed' THEN 'split_created'
              WHEN source.proposal_origin = 'blanket' AND source.status = 'cancelled' THEN 'cancelled'
              WHEN review.status = 'completed' THEN 'po_created'
              WHEN review.status = 'executing' THEN 'po_creating'
              WHEN review.status IN ('failed', 'attention') THEN 'attention'
              WHEN review.status = 'cancelled' THEN 'cancelled'
              WHEN review.id IS NOT NULL THEN 'po_pending'
              WHEN source.status = 'vendor_replied' THEN 'vendor_replied'
              WHEN source.status = 'cancelled' THEN 'cancelled'
              ELSE 'order_requested'
            END,
            review.netsuite_purchase_order_id,
            review.netsuite_purchase_order_ref,
            CASE
              WHEN review.status = 'completed' THEN COALESCE(review.updated_at, now())
              WHEN source.proposal_origin = 'blanket' AND source.status IN ('completed', 'cancelled') THEN now()
              ELSE NULL
            END,
            CASE
              WHEN review.status = 'completed'
                OR source.proposal_origin = 'blanket' AND source.status IN ('completed', 'cancelled')
              THEN 'runtime-backfill'
              ELSE NULL
            END,
            CASE
              WHEN review.status = 'completed' THEN 'completed_backfill'
              WHEN source.proposal_origin = 'blanket' AND source.status IN ('completed', 'cancelled') THEN 'blanket_terminal'
              ELSE NULL
            END,
            COALESCE(source.order_requested_at, source.created_at, now()),
            COALESCE(review.updated_at, source.order_requested_at, source.created_at, now())
       FROM scm_smart_proposals source
       LEFT JOIN latest_review review ON review.parent_proposal_id = source.id
      WHERE source.proposal_type = 'PO'
        AND source.vendor_resolution_kind IS NULL
        AND (source.order_requested_at IS NOT NULL OR review.id IS NOT NULL)
     ON CONFLICT (source_proposal_id) DO NOTHING`
  );

  const reviews = await latestReviewBySource();
  for (const review of reviews.rows) {
    const status = review.status === "completed"
      ? "po_created"
      : review.status === "executing"
        ? "po_creating"
        : ["failed", "attention"].includes(review.status)
          ? "attention"
          : review.status === "cancelled"
            ? "cancelled"
            : "po_pending";
    await query(
      `UPDATE scm_smart_vendor_workflows
          SET review_proposal_id = $2,
              workflow_status = $3,
              netsuite_purchase_order_id = COALESCE($4, netsuite_purchase_order_id),
              netsuite_purchase_order_ref = COALESCE(NULLIF($5, ''), netsuite_purchase_order_ref),
              version = version + 1,
              updated_at = now()
        WHERE source_proposal_id = $1
          AND (review_proposal_id IS DISTINCT FROM $2
            OR workflow_status IS DISTINCT FROM $3
            OR netsuite_purchase_order_id IS DISTINCT FROM COALESCE($4, netsuite_purchase_order_id)
            OR netsuite_purchase_order_ref IS DISTINCT FROM COALESCE(NULLIF($5, ''), netsuite_purchase_order_ref))`,
      [Number(review.parent_proposal_id), Number(review.id), status,
        review.netsuite_purchase_order_id, review.netsuite_purchase_order_ref]
    );
  }
  await query(
    `UPDATE scm_smart_vendor_workflows workflow
        SET workflow_status = 'cancelled',
            version = version + 1,
            updated_at = now()
       FROM scm_smart_proposals source
      WHERE source.id = workflow.source_proposal_id
        AND source.status = 'cancelled'
        AND workflow.review_proposal_id IS NULL
        AND workflow.workflow_status <> 'cancelled'`
  );
  await query(
    `UPDATE scm_smart_vendor_workflows workflow
        SET workflow_status = 'vendor_replied',
            version = version + 1,
            updated_at = now()
       FROM scm_smart_proposals source
      WHERE source.id = workflow.source_proposal_id
        AND source.status = 'vendor_replied'
        AND workflow.review_proposal_id IS NULL
        AND workflow.workflow_status = 'order_requested'`
  );
}

async function sourceProposalRow(sourceProposalId, { lock = false } = {}) {
  const result = await query(
    `SELECT id, proposal_type, proposal_origin, blanket_source_po_id,
            blanket_source_po_ref, vendor_resolution_kind, status,
            order_requested_at, created_at
       FROM scm_smart_proposals
      WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [Number(sourceProposalId)]
  );
  return result.rows[0] || null;
}

export async function ensureSmartScmVendorWorkflow(sourceProposalId, operatorId = null) {
  const id = Number(sourceProposalId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("Select a valid Vendor Replies proposal."), { status: 400 });
  }
  const workflow = await withTransaction(async () => {
    const source = await sourceProposalRow(id, { lock: true });
    if (!source) throw Object.assign(new Error("Vendor Replies proposal was not found."), { status: 404 });
    if (source.proposal_type !== "PO" || source.vendor_resolution_kind !== null) {
      throw Object.assign(new Error("A Vendor Replies workflow requires an original PO proposal."), { status: 409 });
    }
    const kind = workflowKindForProposal(source);
    const inserted = await query(
      `INSERT INTO scm_smart_vendor_workflows (
         workflow_key, workflow_kind, source_proposal_id,
         source_purchase_order_id, source_purchase_order_ref, workflow_status,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, COALESCE($7, now()), now())
       ON CONFLICT (source_proposal_id) DO UPDATE SET
         workflow_kind = EXCLUDED.workflow_kind,
         source_purchase_order_id = COALESCE(EXCLUDED.source_purchase_order_id, scm_smart_vendor_workflows.source_purchase_order_id),
         source_purchase_order_ref = COALESCE(EXCLUDED.source_purchase_order_ref, scm_smart_vendor_workflows.source_purchase_order_ref),
         updated_at = now()
       RETURNING *`,
      [workflowKey(kind, id), kind, id, source.blanket_source_po_id,
        source.blanket_source_po_ref, source.status === "vendor_replied" ? "vendor_replied" : "order_requested",
        source.order_requested_at || source.created_at]
    );
    return publicWorkflowRow(inserted.rows[0]);
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.vendor_workflow.ensure",
    details: { workflowId: workflow.id, sourceProposalId: workflow.sourceProposalId, workflowKind: workflow.workflowKind }
  });
  return workflow;
}

async function workflowRow(workflowId, { lock = false } = {}) {
  const id = Number(workflowId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("Select a valid Vendor Replies workflow."), { status: 400 });
  }
  const result = await query(
    `SELECT * FROM scm_smart_vendor_workflows WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [id]
  );
  if (!result.rowCount) throw Object.assign(new Error("Vendor Replies workflow was not found."), { status: 404 });
  return result.rows[0];
}

async function vendorIdentityForWorkflow(workflow, lines = []) {
  if (workflow.sourcePurchaseOrderId) {
    const sourceOrder = await query(
      "SELECT vendor_id FROM purchase_orders WHERE netsuite_id = $1",
      [workflow.sourcePurchaseOrderId]
    );
    const vendorId = Number(sourceOrder.rows[0]?.vendor_id);
    if (Number.isInteger(vendorId) && vendorId > 0) return vendorId;
  }
  const itemIds = [...new Set(lines.map((line) => Number(line.itemId ?? line.item_id))
    .filter((itemId) => Number.isInteger(itemId) && itemId > 0))];
  if (!itemIds.length) return null;
  const result = await query(
    `SELECT ARRAY_REMOVE(ARRAY_AGG(DISTINCT vendor_id), NULL) AS vendor_ids
       FROM inventory_items
      WHERE item_id = ANY($1::bigint[])`,
    [itemIds]
  );
  const vendorIds = result.rows[0]?.vendor_ids || [];
  return vendorIds.length === 1 ? Number(vendorIds[0]) : null;
}

async function itemMetadataForLines(lines = [], { vendorId = null } = {}) {
  const itemIds = [...new Set(lines.map((line) => Number(line.itemId ?? line.item_id))
    .filter((itemId) => Number.isInteger(itemId) && itemId > 0))];
  if (!itemIds.length) return { metadata: new Map(), lookupError: "" };
  const result = await query(
    `SELECT requested.item_id,
            COALESCE(item.item_name, policy.item_name) AS item_name,
            COALESCE(item.item_description, policy.item_description) AS item_description,
            item.stock_unit,
            item.purchase_unit,
            item.last_purchase_price,
            item.synced_at AS last_purchase_price_synced_at
       FROM unnest($1::bigint[]) AS requested(item_id)
       LEFT JOIN inventory_items item ON item.item_id = requested.item_id
       LEFT JOIN scm_smart_item_policies policy ON policy.item_id = requested.item_id`,
    [itemIds]
  );
  const metadata = new Map(result.rows.map((row) => [Number(row.item_id), {
    itemName: row.item_name,
    description: row.item_description,
    stockUnit: row.stock_unit || null,
    purchaseUnit: row.purchase_unit || null,
    lastPurchasePrice: row.last_purchase_price === null || row.last_purchase_price === undefined
      ? null
      : Number(row.last_purchase_price),
    lastPurchasePriceSyncedAt: row.last_purchase_price_synced_at || null,
    vendorCode: "",
    vendorCodeSource: "",
    vendorPrice: null,
    vendorPriceSyncedAt: null
  }]));
  let lookupError = "";
  if (Number.isInteger(Number(vendorId)) && Number(vendorId) > 0) {
    try {
      const codes = await resolveSmartScmVendorItemCodes({ vendorId: Number(vendorId), itemIds });
      for (const code of codes) {
        const current = metadata.get(Number(code.itemId)) || {};
        metadata.set(Number(code.itemId), {
          ...current,
          vendorCode: code.vendorCode || "",
          vendorCodeSource: code.source || "item_vendor",
          vendorPrice: code.vendorPrice === null || code.vendorPrice === undefined
            ? null
            : Number(code.vendorPrice),
          vendorPriceSyncedAt: code.vendorPriceSyncedAt || null
        });
      }
      const refreshError = codes.find((code) => code.refreshError)?.refreshError;
      if (refreshError) lookupError = text(refreshError);
    } catch (error) {
      lookupError = text(error?.message || error);
    }
  } else {
    lookupError = "The load does not resolve to one NetSuite vendor; vendor codes can be entered manually.";
  }
  return { metadata, lookupError };
}

async function purchaseOrderFinancialLinesByOrderIds(orderIds = []) {
  const ids = [...new Set((orderIds || []).map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
  const byOrderId = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return byOrderId;
  const result = await query(
    `SELECT purchase_order_id AS "purchaseOrderId",
            id, line_id AS "lineId", item_id AS "itemId",
            location_id AS "locationId", quantity, unit, rate, amount,
            netsuite_active AS "netsuiteActive",
            netsuite_closed AS "netsuiteClosed", synced_at AS "syncedAt"
       FROM purchase_order_lines
      WHERE purchase_order_id = ANY($1::bigint[])
        AND netsuite_active IS DISTINCT FROM false
      ORDER BY purchase_order_id, line_id, id`,
    [ids]
  );
  for (const line of result.rows) {
    const orderId = Number(line.purchaseOrderId);
    if (!byOrderId.has(orderId)) byOrderId.set(orderId, []);
    byOrderId.get(orderId).push(line);
  }
  return byOrderId;
}

function defaultEmailDraft(source, workflow) {
  const vendor = text(source?.vendor || source?.sourceName) || "Vendor";
  const sourcePoRef = workflow.workflowKind === "blanket_po"
    ? text(workflow.sourcePurchaseOrderRef)
    : "";
  const sourcePoLabel = sourcePoRef ? ` - Source PO ${sourcePoRef}` : "";
  return {
    to: workflow.emailTo || "",
    subject: workflow.emailSubject || `Purchase order request - ${vendor}${sourcePoLabel} - Load #${workflow.sourceProposalId}`,
    intro: workflow.emailIntro || "Hello,\n\nPlease review the requested items below and confirm availability and ready date.",
    closing: workflow.emailClosing || "Thank you,"
  };
}

async function enrichWorkflow(row, { purchaseOrderFinancialsByOrderId = null } = {}) {
  const workflow = publicWorkflowRow(row);
  const [source, review] = await Promise.all([
    getSmartScmProposal(workflow.sourceProposalId),
    workflow.reviewProposalId ? getSmartScmProposal(workflow.reviewProposalId) : Promise.resolve(null)
  ]);
  if (!source) throw Object.assign(new Error("The source Vendor Replies proposal no longer exists."), { status: 409 });
  const display = review || source;
  const displayLines = display.lines?.length ? display.lines : source.lines || [];
  const physicalPalletLines = Array.isArray(display.physicalPalletLines) ? display.physicalPalletLines : [];
  const vendorId = await vendorIdentityForWorkflow(workflow, displayLines);
  const immutableReview = Boolean(review);
  const { metadata, lookupError } = immutableReview
    ? { metadata: new Map(), lookupError: "" }
    : await itemMetadataForLines(
      [...displayLines, ...physicalPalletLines],
      { vendorId }
    );
  const snapshotFinancialLines = displayLines.map((line) => smartScmVendorFinancialLine({
    line,
    metadata: metadata.get(Number(line.itemId)) || {}
  }));
  const snapshotFinancialPalletLines = physicalPalletLines.map((line) => smartScmVendorFinancialLine({
    line,
    metadata: metadata.get(Number(line.itemId)) || {}
  }));
  const linkedPurchaseOrderId = Number(workflow.netsuitePurchaseOrderId || display.netsuitePurchaseOrderId);
  const hasLinkedPurchaseOrder = workflow.workflowKind === "regular_po"
    && Number.isInteger(linkedPurchaseOrderId)
    && linkedPurchaseOrderId > 0;
  const purchaseOrderFinancials = hasLinkedPurchaseOrder
    ? purchaseOrderFinancialsByOrderId instanceof Map
      ? purchaseOrderFinancialsByOrderId.get(linkedPurchaseOrderId) || []
      : (await purchaseOrderFinancialLinesByOrderIds([linkedPurchaseOrderId])).get(linkedPurchaseOrderId) || []
    : [];
  const financialLines = hasLinkedPurchaseOrder
    ? overlaySmartScmVendorPoFinancials({
        lines: snapshotFinancialLines,
        purchaseOrderLines: purchaseOrderFinancials
      })
    : snapshotFinancialLines;
  const financialPalletLines = hasLinkedPurchaseOrder
    ? overlaySmartScmVendorPoFinancials({
        lines: snapshotFinancialPalletLines,
        purchaseOrderLines: purchaseOrderFinancials
      })
    : snapshotFinancialPalletLines;
  const emailRows = groupSmartScmVendorEmailRows(
    financialLines,
    metadata,
    workflow.vendorCodeOverrides
  );
  const draft = defaultEmailDraft(source, workflow);
  const regular = workflow.workflowKind === "regular_po";
  const activeSource = !workflow.reviewProposalId
    && ["order_requested", "vendor_replied"].includes(source.status);
  return {
    ...display,
    lines: financialLines,
    physicalPalletLines: financialPalletLines,
    id: workflow.sourceProposalId,
    displayProposalId: display.id,
    sourceProposalId: workflow.sourceProposalId,
    sourceStatus: source.status,
    sourceLines: source.lines || [],
    workflowId: workflow.id,
    workflowKey: workflow.workflowKey,
    workflowKind: workflow.workflowKind,
    workflowStatus: workflow.workflowStatus,
    reviewProposalId: workflow.reviewProposalId,
    sourcePurchaseOrderId: workflow.sourcePurchaseOrderId,
    sourcePurchaseOrderRef: workflow.sourcePurchaseOrderRef,
    netsuitePurchaseOrderId: workflow.netsuitePurchaseOrderId || display.netsuitePurchaseOrderId || null,
    netsuitePurchaseOrderRef: workflow.netsuitePurchaseOrderRef || display.netsuitePurchaseOrderRef || "",
    splitId: workflow.splitId,
    splitPurchaseOrderId: workflow.splitPurchaseOrderId,
    splitPurchaseOrderRef: workflow.splitPurchaseOrderRef,
    workflowArchivedAt: workflow.archivedAt,
    vendorEmailDraft: {
      to: draft.to,
      subject: draft.subject,
      intro: draft.intro,
      closing: draft.closing,
      updatedAt: workflow.emailUpdatedAt,
      updatedBy: workflow.emailUpdatedBy
    },
    vendorEmailRows: emailRows,
    vendorId,
    vendorCodeLookupError: lookupError,
    missingVendorCodeCount: emailRows.filter((line) => line.vendorCodeMissing).length,
    canEditVendorReply: activeSource,
    canCreatePurchaseOrder: regular && !workflow.archivedAt
      && ["order_requested", "vendor_replied", "po_pending", "attention"].includes(workflow.workflowStatus)
      && !workflow.netsuitePurchaseOrderId && !workflow.netsuitePurchaseOrderRef,
    canCreateBlanketSplit: !regular && !workflow.archivedAt
      && ["order_requested", "vendor_replied", "split_pending", "attention"].includes(workflow.workflowStatus),
    canMoveToHistory: regular && !workflow.archivedAt && workflow.workflowStatus === "po_created"
      && Number.isInteger(Number(workflow.netsuitePurchaseOrderId))
      && Number(workflow.netsuitePurchaseOrderId) > 0,
    canRestoreToVendorReplies: regular && Boolean(workflow.archivedAt) && workflow.workflowStatus === "po_created"
  };
}

export async function getSmartScmVendorWorkflow(workflowId) {
  return enrichWorkflow(await workflowRow(workflowId));
}

export async function getSmartScmVendorWorkflowForProposal(sourceProposalId) {
  await backfillSmartScmVendorWorkflows();
  const result = await query(
    "SELECT * FROM scm_smart_vendor_workflows WHERE source_proposal_id = $1",
    [Number(sourceProposalId)]
  );
  if (!result.rowCount) {
    const ensured = await ensureSmartScmVendorWorkflow(sourceProposalId);
    return getSmartScmVendorWorkflow(ensured.id);
  }
  return enrichWorkflow(result.rows[0]);
}

export async function findSmartScmVendorWorkflowByPurchaseOrder({
  purchaseOrderId = null,
  reviewProposalId = null
} = {}) {
  const orderId = Number(purchaseOrderId);
  const reviewId = Number(reviewProposalId);
  const validOrderId = Number.isInteger(orderId) && orderId > 0 ? orderId : null;
  const validReviewId = Number.isInteger(reviewId) && reviewId > 0 ? reviewId : null;
  if (!validOrderId && !validReviewId) {
    throw Object.assign(new Error("A NetSuite purchase-order ID or review proposal ID is required."), { status: 400 });
  }
  await backfillSmartScmVendorWorkflows();
  const result = await query(
    `SELECT *
       FROM scm_smart_vendor_workflows
      WHERE workflow_kind = 'regular_po'
        AND (($1::bigint IS NOT NULL AND netsuite_purchase_order_id = $1)
          OR ($2::bigint IS NOT NULL AND review_proposal_id = $2))
      ORDER BY CASE WHEN netsuite_purchase_order_id = $1 THEN 0 ELSE 1 END, id
      LIMIT 2`,
    [validOrderId, validReviewId]
  );
  if (result.rowCount > 1) {
    throw Object.assign(new Error("The PO history identity matches more than one Vendor Replies workflow."), { status: 409 });
  }
  return publicWorkflowRow(result.rows[0] || null);
}

export async function listSmartScmVendorWorkflowLoads({ search = "", limit = 500, archived = false } = {}) {
  await backfillSmartScmVendorWorkflows();
  const result = await query(
    `SELECT workflow.*
       FROM scm_smart_vendor_workflows workflow
       JOIN scm_smart_proposals source ON source.id = workflow.source_proposal_id
       LEFT JOIN scm_smart_proposals review ON review.id = workflow.review_proposal_id
      WHERE ${archived
        ? "workflow.archived_at IS NOT NULL"
        : "workflow.archived_at IS NULL AND workflow.workflow_status <> 'cancelled'"}
        AND ($1 = ''
          OR workflow.id::text ILIKE '%' || $1 || '%'
          OR source.id::text ILIKE '%' || $1 || '%'
          OR COALESCE(source.vendor, '') ILIKE '%' || $1 || '%'
          OR COALESCE(source.source_name, '') ILIKE '%' || $1 || '%'
          OR COALESCE(source.destination_name, '') ILIKE '%' || $1 || '%'
          OR COALESCE(workflow.source_purchase_order_ref, '') ILIKE '%' || $1 || '%'
          OR COALESCE(workflow.netsuite_purchase_order_ref, '') ILIKE '%' || $1 || '%'
          OR COALESCE(workflow.split_purchase_order_ref, '') ILIKE '%' || $1 || '%'
          OR EXISTS (
            SELECT 1
              FROM scm_smart_proposal_lines line
             WHERE line.proposal_id IN (source.id, review.id)
               AND (line.item_id::text ILIKE '%' || $1 || '%'
                 OR line.item_name ILIKE '%' || $1 || '%')
          ))
      ORDER BY workflow.updated_at DESC, workflow.id DESC
      LIMIT $2`,
    [text(search), Math.min(1000, Math.max(1, Number(limit) || 500))]
  );
  const purchaseOrderFinancialsByOrderId = await purchaseOrderFinancialLinesByOrderIds(
    result.rows.map((row) => row.netsuite_purchase_order_id)
  );
  const loads = [];
  for (const row of result.rows) {
    loads.push(await enrichWorkflow(row, { purchaseOrderFinancialsByOrderId }));
  }
  return loads;
}

export async function saveSmartScmVendorEmailDraft(workflowId, values = {}, operatorId = null) {
  const to = limitedText(values.to, EMAIL_TO_LIMIT, "Email recipients");
  const subject = limitedText(values.subject, EMAIL_SUBJECT_LIMIT, "Email subject");
  const intro = limitedText(values.intro, EMAIL_BODY_LIMIT, "Email introduction");
  const closing = limitedText(values.closing, EMAIL_BODY_LIMIT, "Email closing");
  const overrides = vendorCodeOverrides(values.vendorCodes || values.vendorCodeOverrides || {});
  const updated = await query(
    `UPDATE scm_smart_vendor_workflows
        SET email_to = $2,
            email_subject = $3,
            email_intro = $4,
            email_closing = $5,
            vendor_code_overrides = $6::jsonb,
            email_updated_at = now(),
            email_updated_by = $7,
            version = version + 1,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [Number(workflowId), to, subject, intro, closing, JSON.stringify(overrides), operatorId]
  );
  if (!updated.rowCount) throw Object.assign(new Error("Vendor Replies workflow was not found."), { status: 404 });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.vendor_workflow.email_draft_saved",
    details: { workflowId: Number(workflowId), vendorCodeItemIds: Object.keys(overrides), missingCodesAllowed: true }
  });
  return enrichWorkflow(updated.rows[0]);
}

export async function linkSmartScmVendorWorkflowReview(workflowId, reviewProposalId, operatorId = null) {
  const reviewId = Number(reviewProposalId);
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    throw Object.assign(new Error("A valid staged PO review is required."), { status: 400 });
  }
  const updated = await query(
    `UPDATE scm_smart_vendor_workflows workflow
        SET review_proposal_id = review.id,
            workflow_status = CASE
              WHEN review.status = 'executing' THEN 'po_creating'
              WHEN review.status IN ('failed', 'attention') THEN 'attention'
              WHEN review.status = 'completed' THEN 'po_created'
              ELSE 'po_pending'
            END,
            netsuite_purchase_order_id = COALESCE(review.netsuite_purchase_order_id, workflow.netsuite_purchase_order_id),
            netsuite_purchase_order_ref = COALESCE(review.netsuite_purchase_order_ref, workflow.netsuite_purchase_order_ref),
            version = workflow.version + 1,
            updated_at = now()
       FROM scm_smart_proposals review
      WHERE workflow.id = $1
        AND review.id = $2
        AND review.vendor_resolution_kind = 'netsuite_po_review'
        AND review.parent_proposal_id = workflow.source_proposal_id
      RETURNING workflow.*`,
    [Number(workflowId), reviewId]
  );
  if (!updated.rowCount) {
    throw Object.assign(new Error("The staged PO review does not belong to this Vendor Replies workflow."), { status: 409 });
  }
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.vendor_workflow.review_linked",
    details: { workflowId: Number(workflowId), reviewProposalId: reviewId }
  });
  return enrichWorkflow(updated.rows[0]);
}

export async function getSmartScmVendorWorkflowActionTarget(workflowId) {
  await backfillSmartScmVendorWorkflows();
  const workflow = publicWorkflowRow(await workflowRow(workflowId));
  if (workflow.archivedAt) throw Object.assign(new Error("Restore this workflow before performing another action."), { status: 409 });
  return {
    workflowId: workflow.id,
    workflowKind: workflow.workflowKind,
    sourceProposalId: workflow.sourceProposalId,
    reviewProposalId: workflow.reviewProposalId,
    needsStaging: workflow.workflowKind === "regular_po" && !workflow.reviewProposalId,
    sourcePurchaseOrderId: workflow.sourcePurchaseOrderId,
    sourcePurchaseOrderRef: workflow.sourcePurchaseOrderRef,
    workflowStatus: workflow.workflowStatus,
    netsuitePurchaseOrderId: workflow.netsuitePurchaseOrderId,
    netsuitePurchaseOrderRef: workflow.netsuitePurchaseOrderRef,
    splitId: workflow.splitId,
    splitPurchaseOrderId: workflow.splitPurchaseOrderId,
    splitPurchaseOrderRef: workflow.splitPurchaseOrderRef
  };
}

export async function recordSmartScmVendorWorkflowPurchaseResult(workflowId, result = {}, operatorId = null) {
  const purchaseOrderId = Number(result.purchaseOrderId);
  const validPurchaseOrderId = Number.isInteger(purchaseOrderId) && purchaseOrderId > 0 ? purchaseOrderId : null;
  const purchaseOrderRef = text(result.purchaseOrderRef);
  if (!validPurchaseOrderId && !purchaseOrderRef) {
    throw Object.assign(new Error("NetSuite PO creation returned no durable purchase-order identity."), { status: 409 });
  }
  const updated = await query(
    `UPDATE scm_smart_vendor_workflows
        SET review_proposal_id = COALESCE($2, review_proposal_id),
            workflow_status = 'po_created',
            netsuite_purchase_order_id = COALESCE($3, netsuite_purchase_order_id),
            netsuite_purchase_order_ref = COALESCE(NULLIF($4, ''), netsuite_purchase_order_ref),
            archived_at = NULL,
            archived_by = NULL,
            archive_reason = NULL,
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND workflow_kind = 'regular_po'
      RETURNING *`,
    [Number(workflowId), result.reviewProposalId || null, validPurchaseOrderId, purchaseOrderRef]
  );
  if (!updated.rowCount) throw Object.assign(new Error("A regular Vendor Replies workflow was not found."), { status: 404 });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.vendor_workflow.purchase_created",
    orderId: validPurchaseOrderId,
    details: { workflowId: Number(workflowId), reviewProposalId: result.reviewProposalId || null, purchaseOrderId: validPurchaseOrderId, purchaseOrderRef }
  });
  return enrichWorkflow(updated.rows[0]);
}

export async function recordSmartScmVendorWorkflowAttention(workflowId, error, operatorId = null) {
  const message = limitedText(error?.message || error || "Vendor workflow requires attention.", 2000, "Attention message");
  const updated = await query(
    `UPDATE scm_smart_vendor_workflows
        SET workflow_status = 'attention', version = version + 1, updated_at = now()
      WHERE id = $1
        AND workflow_status NOT IN ('po_created', 'split_created', 'cancelled')
      RETURNING *`,
    [Number(workflowId)]
  );
  if (!updated.rowCount) {
    const current = await workflowRow(workflowId);
    if (!current) throw Object.assign(new Error("Vendor Replies workflow was not found."), { status: 404 });
    return enrichWorkflow(current);
  }
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.vendor_workflow.attention",
    details: { workflowId: Number(workflowId), error: message }
  });
  return enrichWorkflow(updated.rows[0]);
}

export async function recordSmartScmVendorWorkflowBlanketSplit(workflowId, result = {}, operatorId = null) {
  const releaseStatus = text(result.release?.status || result.releaseStatus || result.status).toLowerCase();
  const terminal = ["released", "cancelled"].includes(releaseStatus);
  const splitRef = text(
    result.splitPurchaseOrderRef
    || result.splitPoRef
    || result.release?.splitPoRef
    || result.split?.splitPoRef
    || result.split?.split?.splitPoRef
  );
  if (releaseStatus === "released" && !splitRef) {
    throw Object.assign(new Error("The completed blanket release returned no split PO reference."), { status: 409 });
  }
  const updated = await query(
    `UPDATE scm_smart_vendor_workflows
        SET workflow_status = CASE
              WHEN $6 = 'released' THEN 'split_created'
              WHEN $6 = 'cancelled' THEN 'cancelled'
              ELSE 'split_pending'
            END,
            split_id = COALESCE($2, split_id),
            split_purchase_order_id = COALESCE($3, split_purchase_order_id),
            split_purchase_order_ref = COALESCE(NULLIF($4, ''), split_purchase_order_ref),
            archived_at = CASE WHEN $7 THEN COALESCE(archived_at, now()) ELSE NULL END,
            archived_by = CASE WHEN $7 THEN $5 ELSE NULL END,
            archive_reason = CASE
              WHEN $6 = 'released' THEN 'blanket_completed'
              WHEN $6 = 'cancelled' THEN 'blanket_cancelled'
              ELSE NULL
            END,
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND workflow_kind = 'blanket_po'
      RETURNING *`,
    [Number(workflowId), result.splitId || result.release?.splitId || result.split?.id || result.split?.split?.id || null,
      result.splitPurchaseOrderId || result.release?.splitPoId || result.split?.splitPoId || result.split?.split?.splitPoId || null,
      splitRef, operatorId, releaseStatus, terminal]
  );
  if (!updated.rowCount) throw Object.assign(new Error("A blanket Vendor Replies workflow was not found."), { status: 404 });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.vendor_workflow.blanket_split_created",
    details: {
      workflowId: Number(workflowId),
      releaseStatus,
      splitPurchaseOrderRef: splitRef || null,
      archived: terminal
    }
  });
  return enrichWorkflow(updated.rows[0]);
}

export async function setSmartScmVendorWorkflowArchived(workflowId, { archived = true } = {}, operatorId = null) {
  const updated = await withTransaction(async () => {
    const current = await workflowRow(workflowId, { lock: true });
    if (current.workflow_kind !== "regular_po") {
      throw Object.assign(new Error("Blanket releases move to Blanket history automatically and cannot be restored here."), { status: 409 });
    }
    if (current.workflow_status !== "po_created"
      || (!current.netsuite_purchase_order_id && !text(current.netsuite_purchase_order_ref))) {
      throw Object.assign(new Error("Only a created regular purchase order can move between Vendor Replies and PO history."), { status: 409 });
    }
    const result = await query(
      `UPDATE scm_smart_vendor_workflows
          SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now()) ELSE NULL END,
              archived_by = CASE WHEN $2 THEN $3 ELSE NULL END,
              archive_reason = CASE WHEN $2 THEN 'manual_history_move' ELSE NULL END,
              version = version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [Number(workflowId), Boolean(archived), operatorId]
    );
    return result.rows[0];
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: archived
      ? "smart_scm.vendor_workflow.moved_to_history"
      : "smart_scm.vendor_workflow.restored_to_vendor_replies",
    details: { workflowId: Number(workflowId), reversible: true }
  });
  return enrichWorkflow(updated);
}

export async function setSmartScmVendorWorkflowArchivedByPurchaseOrder(
  { purchaseOrderId = null, reviewProposalId = null, archived = true } = {},
  operatorId = null
) {
  const workflow = await findSmartScmVendorWorkflowByPurchaseOrder({ purchaseOrderId, reviewProposalId });
  if (!workflow) {
    throw Object.assign(new Error("No Vendor Replies workflow is linked to this application-created purchase order."), { status: 404 });
  }
  return setSmartScmVendorWorkflowArchived(workflow.id, { archived }, operatorId);
}
