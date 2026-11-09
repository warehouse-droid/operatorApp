/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Single-script webhook option. Deploy this file directly on:
 * - Sales Order
 * - Purchase Order
 * - Transfer Order
 *
 * Manual Sales Order approval requires the deployment's Context Filtering to
 * include the Approve event and the User Interface execution context.
 *
 * The native Close button does not run afterSubmit. NetSuite reloads the
 * order in view mode after a Close, so beforeLoad (View, User Interface)
 * sends a Closed order modified within the last day with eventType "close".
 * The deployment's Context Filtering must therefore include the View event.
 *
 * Fulfillments, receipts and invoices change their order's status and
 * fulfilled/received quantities without running the order's own User Event.
 * Deploy this same file on Item Fulfillment and Item Receipt (and optionally
 * Invoice / Cash Sale). When one is created, deleted, shipped, or edited in a
 * way that changes its quantities, it sends the parent SO/PO/TO, the same
 * order payload as an order edit, with trigger "child_transaction". The
 * fulfillment/receipt itself is not sent. Edits that leave the
 * quantities alone (memo, tracking) and transactions not created from an
 * SO/PO/TO (RMA, vendor return) send nothing.
 *
 * Sending, the 10-second retry and the payload format live in
 * netsuite-order-webhook-lib.js, which must be uploaded to the same File
 * Cabinet folder as this file under exactly that name.
 *
 * Script parameters:
 * - custscriptmbbs_webhook_url or custscript_mbbs_webhook_url
 * - custscriptwh_webhook_secret_i or custscript_mbbs_webhook_secret
 */
define(["N/log", "N/runtime", "N/search", "./netsuite-order-webhook-lib"], (log, runtime, search, lib) => {
  const { textValue, getValueSafe, getTextSafe, getLineValueSafe, mapRecordType, sendWebhook } = lib;
  const CLOSE_RELOAD_TRIGGER = "close_reload";
  const CLOSE_RELOAD_WINDOW_MS = 24 * 60 * 60 * 1000;
  const CHILD_TRIGGER = "child_transaction";
  const ORDER_TYPES = ["salesorder", "purchaseorder", "transferorder"];
  const PARENT_ORDER_TYPES = {
    salesord: "salesorder",
    purchord: "purchaseorder",
    trnfrord: "transferorder",
    "sales order": "salesorder",
    "purchase order": "purchaseorder",
    "transfer order": "transferorder"
  };
  const CHILD_LINE_FIELDS = ["orderline", "item", "itemreceive", "quantity", "location"];

  // The order whose current state is sent: the record itself for an order
  // event, or the parent order for a fulfillment/receipt/invoice event.
  function orderTarget(context) {
    const rec = context.newRecord;
    return {
      type: mapRecordType(rec && rec.type),
      id: rec && rec.id,
      eventType: textValue(context.type),
      manualApproval: context.type === context.UserEventType.APPROVE
    };
  }

  function statusDiagnostic(context) {
    const script = runtime.getCurrentScript();
    return {
      scriptId: script.id,
      deploymentId: script.deploymentId,
      executionContext: runtime.executionContext,
      recordType: context.newRecord && context.newRecord.type,
      recordId: context.newRecord && context.newRecord.id,
      eventType: context.type,
      manualApproval: context.type === context.UserEventType.APPROVE,
      newStatus: getValueSafe(context.newRecord, "orderstatus")
        || getValueSafe(context.newRecord, "status"),
      newStatusText: getTextSafe(context.newRecord, "status")
        || getTextSafe(context.newRecord, "orderstatus")
    };
  }

  function isClosedStatus(status, statusText) {
    return textValue(status).trim().toUpperCase() === "H"
      || /\bclosed\b/i.test(textValue(statusText));
  }

  function modifiedWithinCloseWindow(rec) {
    const value = getValueSafe(rec, "lastmodifieddate");
    const time = value instanceof Date ? value.getTime() : Date.parse(textValue(value));
    // Server-side Date values can be shifted by the user/server time-zone
    // difference, so the window is wide and two-sided. If the time cannot be
    // read, send anyway: the app ignores a payload it has already received.
    if (!Number.isFinite(time)) return true;
    return Math.abs(Date.now() - time) <= CLOSE_RELOAD_WINDOW_MS;
  }

  // NetSuite's native Close button closes the order without running
  // afterSubmit, then reloads the order in view mode. Send the closed order
  // from that reload so the app learns about the close.
  function isOrderType(type) {
    return ORDER_TYPES.indexOf(mapRecordType(type)) >= 0;
  }

  function beforeLoad(context) {
    try {
      if (context.type !== context.UserEventType.VIEW) return;
      if (runtime.executionContext !== runtime.ContextType.USER_INTERFACE) return;
      if (!context.newRecord || !isOrderType(context.newRecord.type)) return;
      const diagnostic = statusDiagnostic(context);
      if (!isClosedStatus(diagnostic.newStatus, diagnostic.newStatusText)) return;
      if (!modifiedWithinCloseWindow(context.newRecord)) return;
      diagnostic.trigger = CLOSE_RELOAD_TRIGGER;
      log.audit("MBBS webhook invoked", diagnostic);
      sendWebhook(orderTarget(context), diagnostic, { eventType: "close", trigger: CLOSE_RELOAD_TRIGGER });
    } catch (error) {
      log.error("MBBS webhook close check failed", {
        recordId: context.newRecord && context.newRecord.id,
        name: error.name,
        message: error.message
      });
    }
  }

  // What a fulfillment/receipt/invoice does to its order: ship status plus
  // each line's order line, item, included flag, quantity and location.
  function childSignature(rec) {
    if (!rec) return "";
    let count = 0;
    try {
      count = rec.getLineCount({ sublistId: "item" }) || 0;
    } catch (error) {
      count = 0;
    }
    const parts = [textValue(getValueSafe(rec, "shipstatus"))];
    for (let line = 0; line < count; line += 1) {
      parts.push(CHILD_LINE_FIELDS.map((fieldId) => textValue(getLineValueSafe(rec, line, fieldId))).join("|"));
    }
    return parts.join("\n");
  }

  // Create, delete, ship, pack and inline edits always change the order.
  // A full edit changes it only if the quantities or ship status changed.
  function childChangesOrder(context) {
    if (context.type !== context.UserEventType.EDIT) return true;
    return childSignature(context.oldRecord) !== childSignature(context.newRecord);
  }

  function lookupCode(value) {
    const entry = Array.isArray(value) ? value[0] : value;
    if (entry && typeof entry === "object") return textValue(entry.value || entry.text);
    return textValue(entry);
  }

  // The SO/PO/TO the transaction was created from, or null for a standalone
  // transaction or one created from another record type (RMA, vendor return).
  function parentOrder(rec) {
    const id = textValue(getValueSafe(rec, "createdfrom")).trim();
    if (!id) return null;
    const fields = search.lookupFields({ type: "transaction", id, columns: ["type"] });
    const type = PARENT_ORDER_TYPES[lookupCode(fields && fields.type).trim().toLowerCase()];
    return type ? { type, id } : null;
  }

  function sendParentOrder(context) {
    const isDelete = context.type === context.UserEventType.DELETE;
    const child = isDelete ? context.oldRecord || context.newRecord : context.newRecord;
    const script = runtime.getCurrentScript();
    const childType = mapRecordType(child && child.type);
    const diagnostic = {
      scriptId: script.id,
      deploymentId: script.deploymentId,
      executionContext: runtime.executionContext,
      trigger: CHILD_TRIGGER,
      eventType: context.type,
      childRecordType: childType,
      childRecordId: child && child.id,
      childTranid: textValue(getValueSafe(child, "tranid"))
    };
    try {
      if (!child || !childChangesOrder(context)) {
        log.debug("MBBS webhook skipped: order unchanged", diagnostic);
        return;
      }
      const parent = parentOrder(child);
      if (!parent) {
        log.debug("MBBS webhook skipped: no SO/PO/TO parent", diagnostic);
        return;
      }
      diagnostic.recordType = parent.type;
      diagnostic.recordId = parent.id;
      log.audit("MBBS webhook invoked", diagnostic);
      sendWebhook(
        { type: parent.type, id: parent.id, eventType: `${childType}_${textValue(context.type)}`, manualApproval: false },
        diagnostic,
        {
          trigger: CHILD_TRIGGER,
          sourceTransaction: {
            recordType: childType,
            id: child.id,
            tranid: diagnostic.childTranid,
            eventType: textValue(context.type)
          }
        }
      );
    } catch (error) {
      // A failed lookup must not fail the fulfillment, receipt or invoice.
      log.error("MBBS webhook exception", {
        ...diagnostic,
        name: error.name,
        message: error.message,
        stack: error.stack
      });
    }
  }

  function afterSubmit(context) {
    const rec = context.newRecord || context.oldRecord;
    if (!isOrderType(rec && rec.type)) {
      sendParentOrder(context);
      return;
    }
    if (context.type === context.UserEventType.DELETE) return;
    const diagnostic = statusDiagnostic(context);

    // If this entry is absent from the execution log, NetSuite deployment
    // filtering prevented the User Event from running.
    log.audit("MBBS webhook invoked", diagnostic);
    sendWebhook(orderTarget(context), diagnostic, {});
  }

  return { beforeLoad, afterSubmit };
});
