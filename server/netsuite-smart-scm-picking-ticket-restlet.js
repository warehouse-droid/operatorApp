/**
 * MBBS NetSuite RESTlet
 *
 * GET/POST action=health
 *   Read-only connectivity and environment probe. Pass requireSandbox=true to
 *   reject an accidental production deployment.
 *
 * GET/POST action=pickingTicket
 *   Renders a transaction picking ticket. For backward compatibility, omitting
 *   action while supplying entityId also renders a picking ticket.
 *
 * POST action=purchaseOrderPdf renders the current native transaction PDF.
 * POST action=updatePurchaseOrder applies narrowly scoped, version-checked PO edits.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(["N/error", "N/log", "N/record", "N/render", "N/runtime"], (error, log, record, render, runtime) => {
  const VERSION = "3.0.0";
  const MAX_BASE64_CHARS = 9 * 1024 * 1024;

  function booleanValue(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
  }

  function positiveInteger(value, fieldName, { optional = false } = {}) {
    if (optional && (value === undefined || value === null || String(value).trim() === "")) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw error.create({
        name: "MBBS_INVALID_ARGUMENT",
        message: `${fieldName} must be a positive integer.`,
        notifyOff: true
      });
    }
    return parsed;
  }

  function safeFilename(value, fallback) {
    const filename = String(value || fallback || "picking-ticket.pdf")
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return filename || "picking-ticket.pdf";
  }

  function requestId() {
    return `mbbs-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  }

  function runtimeDetails() {
    const script = runtime.getCurrentScript();
    const user = runtime.getCurrentUser();
    return {
      accountId: String(runtime.accountId || ""),
      environment: String(runtime.envType || "UNKNOWN"),
      sandbox: runtime.envType === runtime.EnvType.SANDBOX,
      executionContext: String(runtime.executionContext || ""),
      scriptId: String(script.id || ""),
      deploymentId: String(script.deploymentId || ""),
      roleId: Number.isSafeInteger(Number(user.role)) ? Number(user.role) : null,
      userId: Number.isSafeInteger(Number(user.id)) ? Number(user.id) : null,
      remainingUsage: Number(script.getRemainingUsage())
    };
  }

  function assertRequestedEnvironment(request, details) {
    if (booleanValue(request.requireSandbox, false) && !details.sandbox) {
      throw error.create({
        name: "MBBS_NOT_SANDBOX",
        message: "This request requires a NetSuite sandbox, but the RESTlet is running outside a sandbox.",
        notifyOff: true
      });
    }
  }

  function health(request, id) {
    const details = runtimeDetails();
    assertRequestedEnvironment(request, details);
    return {
      ok: true,
      action: "health",
      version: VERSION,
      requestId: id,
      checkedAt: new Date().toISOString(),
      ...details,
      capabilities: {
        health: true,
        pickingTicket: true,
        purchaseOrderPdf: true,
        updatePurchaseOrder: true,
        locationFilter: true,
        metadataOnly: true,
        methods: ["GET", "POST"]
      }
    };
  }

  function pickingTicket(request, id) {
    const details = runtimeDetails();
    assertRequestedEnvironment(request, details);

    const entityId = positiveInteger(request.entityId, "entityId");
    const locationId = positiveInteger(request.location ?? request.locationId, "location", { optional: true });
    const formId = positiveInteger(request.formId, "formId", { optional: true });
    const shipgroup = positiveInteger(request.shipgroup, "shipgroup", { optional: true });
    const includeContent = booleanValue(request.includeContent, true);
    const options = {
      entityId,
      printMode: render.PrintMode.PDF
    };
    if (locationId) options.location = locationId;
    if (formId) options.formId = formId;
    if (shipgroup) options.shipgroup = shipgroup;
    if (request.inCustLocale !== undefined && request.inCustLocale !== null && request.inCustLocale !== "") {
      options.inCustLocale = booleanValue(request.inCustLocale, false);
    }

    const usageBefore = details.remainingUsage;
    const pdf = render.pickingTicket(options);
    const contentBase64 = includeContent ? String(pdf.getContents() || "") : "";
    if (includeContent && !contentBase64) {
      throw error.create({
        name: "MBBS_EMPTY_PDF",
        message: `NetSuite rendered no picking-ticket content for transaction ${entityId}.`,
        notifyOff: true
      });
    }
    if (contentBase64.length > MAX_BASE64_CHARS) {
      throw error.create({
        name: "MBBS_PDF_TOO_LARGE",
        message: `The picking ticket for transaction ${entityId} exceeds the safe RESTlet response limit.`,
        notifyOff: true
      });
    }

    const filename = safeFilename(pdf.name, `transaction-${entityId}-picking-ticket.pdf`);
    const remainingUsage = Number(runtime.getCurrentScript().getRemainingUsage());
    return {
      ok: true,
      action: "pickingTicket",
      version: VERSION,
      requestId: id,
      generatedAt: new Date().toISOString(),
      accountId: details.accountId,
      environment: details.environment,
      sandbox: details.sandbox,
      entityId,
      locationApplied: Boolean(locationId),
      locationId,
      formId,
      shipgroup,
      filename,
      contentType: "application/pdf",
      contentEncoding: "base64",
      contentIncluded: includeContent,
      contentLength: contentBase64.length,
      fileSize: Number.isFinite(Number(pdf.size)) ? Number(pdf.size) : null,
      usageUnitsConsumed: Number.isFinite(usageBefore) && Number.isFinite(remainingUsage)
        ? Math.max(0, usageBefore - remainingUsage)
        : null,
      remainingUsage,
      contentBase64
    };
  }

  function purchaseOrderPdf(request, id) {
    const details = runtimeDetails();
    assertRequestedEnvironment(request, details);
    const entityId = positiveInteger(request.entityId, "entityId");
    const includeContent = booleanValue(request.includeContent, true);
    // render.transaction accepts several transaction types. Loading explicitly
    // as a PO prevents this narrowly scoped endpoint from rendering an
    // unrelated transaction when a caller supplies the wrong internal ID.
    record.load({ type: record.Type.PURCHASE_ORDER, id: entityId, isDynamic: false });
    const pdf = render.transaction({ entityId, printMode: render.PrintMode.PDF });
    const contentBase64 = includeContent ? String(pdf.getContents() || "") : "";
    if (includeContent && !contentBase64) {
      throw error.create({ name: "MBBS_EMPTY_PDF", message: `NetSuite rendered no PO PDF for transaction ${entityId}.`, notifyOff: true });
    }
    if (contentBase64.length > MAX_BASE64_CHARS) {
      throw error.create({ name: "MBBS_PDF_TOO_LARGE", message: `The PO PDF for transaction ${entityId} exceeds the safe response limit.`, notifyOff: true });
    }
    return {
      ok: true,
      action: "purchaseOrderPdf",
      version: VERSION,
      requestId: id,
      generatedAt: new Date().toISOString(),
      accountId: details.accountId,
      environment: details.environment,
      sandbox: details.sandbox,
      entityId,
      filename: safeFilename(pdf.name, `PO-${entityId}.pdf`),
      contentType: "application/pdf",
      contentEncoding: "base64",
      contentIncluded: includeContent,
      contentLength: contentBase64.length,
      fileSize: Number.isFinite(Number(pdf.size)) ? Number(pdf.size) : null,
      contentBase64
    };
  }

  function comparableInstant(value) {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? String(Math.floor(date.getTime() / 1000)) : String(value).trim();
  }

  function dateValue(value, fieldName) {
    if (value === null || value === undefined || value === "") return null;
    const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw error.create({ name: "MBBS_INVALID_ARGUMENT", message: `${fieldName} must use YYYY-MM-DD.`, notifyOff: true });
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  }

  function numericValue(value, fieldName, { positive = false } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (positive ? parsed <= 0 : parsed < 0)) {
      throw error.create({ name: "MBBS_INVALID_ARGUMENT", message: `${fieldName} is invalid.`, notifyOff: true });
    }
    return parsed;
  }

  function updatePurchaseOrder(request, id) {
    const details = runtimeDetails();
    assertRequestedEnvironment(request, details);
    const entityId = positiveInteger(request.entityId, "entityId");
    const po = record.load({ type: record.Type.PURCHASE_ORDER, id: entityId, isDynamic: false });
    const expected = String(request.expectedLastModifiedAt || "").trim();
    const actual = po.getValue({ fieldId: "lastmodifieddate" });
    if (!expected || comparableInstant(expected) !== comparableInstant(actual)) {
      throw error.create({ name: "MBBS_PO_VERSION_CONFLICT", message: `Purchase order ${entityId} changed in NetSuite. Refresh before saving.`, notifyOff: true });
    }

    let statusText = "";
    try {
      statusText = String(po.getText({ fieldId: "orderstatus" }) || "");
    } catch (lookupError) {
      // Line-level receipt/closed checks below remain authoritative when a
      // custom form does not expose orderstatus text.
    }
    const lineCount = po.getLineCount({ sublistId: "item" }) || 0;
    let hasLockedLine = false;
    for (let current = 0; current < lineCount; current += 1) {
      const received = Number(po.getSublistValue({ sublistId: "item", fieldId: "quantityreceived", line: current })
        || po.getSublistValue({ sublistId: "item", fieldId: "quantityshiprecv", line: current }) || 0);
      const closedValue = po.getSublistValue({ sublistId: "item", fieldId: "isclosed", line: current });
      if (received > 0 || /^(t|true|yes|1)$/i.test(String(closedValue || ""))) {
        hasLockedLine = true;
        break;
      }
    }
    if (hasLockedLine || /closed|cancelled|canceled|fully received/i.test(statusText)) {
      throw error.create({ name: "MBBS_PO_READ_ONLY", message: `Purchase order ${entityId} is received, closed, cancelled, or read-only.`, notifyOff: true });
    }

    const header = request.header && typeof request.header === "object" ? request.header : {};
    if (Object.prototype.hasOwnProperty.call(header, "transactionDate")) {
      po.setValue({ fieldId: "trandate", value: dateValue(header.transactionDate, "transactionDate") });
    }
    if (Object.prototype.hasOwnProperty.call(header, "expectedDeliveryDate")) {
      po.setValue({ fieldId: "custbody4", value: dateValue(header.expectedDeliveryDate, "expectedDeliveryDate") || "" });
    }
    if (Object.prototype.hasOwnProperty.call(header, "memo")) {
      po.setValue({ fieldId: "memo", value: String(header.memo || "").slice(0, 4000) });
    }
    if (Object.prototype.hasOwnProperty.call(header, "vendorReference")) {
      po.setValue({ fieldId: "otherrefnum", value: String(header.vendorReference || "").slice(0, 300) });
    }

    const requestedLines = Array.isArray(request.lines) ? request.lines : [];
    const requestedLineIds = new Set();
    requestedLines.forEach((requested, index) => {
      const lineId = positiveInteger(requested.lineId, `lines[${index}].lineId`);
      if (requestedLineIds.has(lineId)) {
        throw error.create({ name: "MBBS_DUPLICATE_PO_LINE", message: `Purchase-order line ${lineId} appears more than once in this update.`, notifyOff: true });
      }
      requestedLineIds.add(lineId);
      let line = -1;
      for (let current = 0; current < lineCount; current += 1) {
        if (Number(po.getSublistValue({ sublistId: "item", fieldId: "lineuniquekey", line: current })) === lineId) {
          line = current;
          break;
        }
      }
      if (line < 0) throw error.create({ name: "MBBS_PO_LINE_MISSING", message: `Purchase-order line ${lineId} no longer exists.`, notifyOff: true });
      const currentItemId = Number(po.getSublistValue({ sublistId: "item", fieldId: "item", line }));
      if (requested.itemId && Number(requested.itemId) !== currentItemId) {
        throw error.create({ name: "MBBS_PO_ITEM_LOCKED", message: `Item identity on line ${lineId} cannot be changed.`, notifyOff: true });
      }
      const received = Number(po.getSublistValue({ sublistId: "item", fieldId: "quantityreceived", line })
        || po.getSublistValue({ sublistId: "item", fieldId: "quantityshiprecv", line }) || 0);
      const closed = /^(t|true|yes|1)$/i.test(String(po.getSublistValue({ sublistId: "item", fieldId: "isclosed", line }) || ""));
      if (received > 0 || closed) {
        throw error.create({ name: "MBBS_PO_LINE_LOCKED", message: `Received or closed line ${lineId} cannot be edited.`, notifyOff: true });
      }
      if (Object.prototype.hasOwnProperty.call(requested, "quantity")) {
        po.setSublistValue({ sublistId: "item", fieldId: "quantity", line, value: numericValue(requested.quantity, `lines[${index}].quantity`, { positive: true }) });
      }
      if (Object.prototype.hasOwnProperty.call(requested, "rate")) {
        po.setSublistValue({ sublistId: "item", fieldId: "rate", line, value: numericValue(requested.rate, `lines[${index}].rate`) });
      }
      if (Object.prototype.hasOwnProperty.call(requested, "locationId")) {
        po.setSublistValue({ sublistId: "item", fieldId: "location", line, value: positiveInteger(requested.locationId, `lines[${index}].locationId`) });
      }
    });
    const savedId = po.save({ enableSourcing: true, ignoreMandatoryFields: false });
    return {
      ok: true,
      action: "updatePurchaseOrder",
      version: VERSION,
      requestId: id,
      entityId: Number(savedId),
      previousLastModifiedAt: actual instanceof Date ? actual.toISOString() : String(actual || ""),
      updatedAt: new Date().toISOString()
    };
  }

  function normalizedAction(request) {
    const explicit = String(request.action || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (!explicit) return request.entityId ? "pickingticket" : "health";
    if (explicit === "ticket" || explicit === "render" || explicit === "renderpickingticket") return "pickingticket";
    return explicit;
  }

  function dispatch(rawRequest = {}) {
    const request = rawRequest && typeof rawRequest === "object" ? rawRequest : {};
    const id = requestId();
    const action = normalizedAction(request);
    try {
      log.audit({
        title: `MBBS RESTlet ${action}`,
        details: {
          requestId: id,
          action,
          entityId: request.entityId || null,
          locationId: request.location ?? request.locationId ?? null,
          environment: String(runtime.envType || "UNKNOWN")
        }
      });
      if (action === "health") return health(request, id);
      if (action === "pickingticket") return pickingTicket(request, id);
      if (action === "purchaseorderpdf") return purchaseOrderPdf(request, id);
      if (action === "updatepurchaseorder") return updatePurchaseOrder(request, id);
      throw error.create({
        name: "MBBS_UNSUPPORTED_ACTION",
        message: `Unsupported action "${String(request.action || "")}". Use health, pickingTicket, purchaseOrderPdf, or updatePurchaseOrder.`,
        notifyOff: true
      });
    } catch (caught) {
      log.error({
        title: `MBBS RESTlet failed (${id})`,
        details: {
          requestId: id,
          action,
          code: String(caught?.name || "UNEXPECTED_ERROR"),
          message: String(caught?.message || caught)
        }
      });
      if (/^MBBS_/.test(String(caught?.name || ""))) throw caught;
      throw error.create({
        name: "MBBS_RESTLET_FAILED",
        message: `The RESTlet request failed. Review NetSuite script logs with reference ${id}.`,
        notifyOff: true
      });
    }
  }

  return {
    get: dispatch,
    post: dispatch
  };
});
