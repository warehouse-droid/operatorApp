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
 * Script parameters:
 * - custscriptmbbs_webhook_url or custscript_mbbs_webhook_url
 * - custscriptwh_webhook_secret_i or custscript_mbbs_webhook_secret
 */
define(["N/https", "N/log", "N/record", "N/runtime", "N/search"], (https, log, record, runtime, search) => {
  const PARAM_URLS = [
    "custscriptmbbs_webhook_url",
    "custscript_mbbs_webhook_url"
  ];
  const PARAM_SECRETS = [
    "custscriptwh_webhook_secret_i",
    "custscript_mbbs_webhook_secret",
    "custscript_webhook_secret_id"
  ];
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

  function textValue(value) {
    return value == null ? "" : String(value);
  }

  function numberValue(value) {
    const number = Number(textValue(value).replace(/,/g, ""));
    return Number.isFinite(number) ? Math.abs(number) : 0;
  }

  function signedNumberValue(value) {
    const number = Number(textValue(value).replace(/,/g, ""));
    return Number.isFinite(number) ? number : 0;
  }

  function scalarLookup(value) {
    if (Array.isArray(value)) return value[0]?.text || value[0]?.value || "";
    if (value && typeof value === "object") return value.text || value.value || "";
    return value == null ? "" : value;
  }

  function scriptParameter(script, names) {
    for (let index = 0; index < names.length; index += 1) {
      try {
        const value = script.getParameter({ name: names[index] });
        if (value) return textValue(value).trim();
      } catch (error) {
        // Optional legacy parameter IDs need not exist on every script record.
      }
    }
    return "";
  }

  function parameterSnapshot(script, names) {
    return names.map((name) => {
      try {
        return { name, configured: Boolean(script.getParameter({ name })), error: "" };
      } catch (error) {
        return { name, configured: false, error: error.message || String(error) };
      }
    });
  }

  function getValueSafe(rec, fieldId) {
    try {
      return rec.getValue({ fieldId });
    } catch (error) {
      return "";
    }
  }

  function getTextSafe(rec, fieldId) {
    try {
      return rec.getText({ fieldId });
    } catch (error) {
      return "";
    }
  }

  function getLineValueSafe(rec, line, fieldId) {
    try {
      return rec.getSublistValue({ sublistId: "item", fieldId, line });
    } catch (error) {
      return "";
    }
  }

  function getLineTextSafe(rec, line, fieldId) {
    try {
      return rec.getSublistText({ sublistId: "item", fieldId, line });
    } catch (error) {
      return "";
    }
  }

  function itemDetails(itemId) {
    if (!itemId) return {};
    try {
      const fields = search.lookupFields({
        type: "item",
        id: itemId,
        columns: ITEM_COLUMNS
      });
      return {
        itemName: scalarLookup(fields.itemid),
        displayName: scalarLookup(fields.displayname),
        description: scalarLookup(fields.salesdescription),
        itemTypeText: scalarLookup(fields.type),
        itemWeight: numberValue(scalarLookup(fields.weight)),
        toPlt: numberValue(scalarLookup(fields.custitem_toplt)),
        toLyr: numberValue(scalarLookup(fields.custitem_tolyr)),
        toSec: numberValue(scalarLookup(fields.custitem_tosec)),
        toPcs: numberValue(scalarLookup(fields.custitem_topcs))
      };
    } catch (error) {
      log.debug("MBBS item lookup skipped", {
        itemId,
        name: error.name,
        message: error.message
      });
      return {};
    }
  }

  const ITEM_COLUMNS = [
    "itemid",
    "displayname",
    "salesdescription",
    "type",
    "weight",
    "custitem_toplt",
    "custitem_tolyr",
    "custitem_tosec",
    "custitem_topcs"
  ];

  // One item search for every item on the order instead of one lookup per
  // item: each lookup is a separate round trip inside the user's save.
  // Items the search does not return fall back to itemDetails().
  function itemDetailsMap(itemIds) {
    const ids = [];
    for (let index = 0; index < itemIds.length; index += 1) {
      const id = textValue(itemIds[index]).trim();
      if (id && ids.indexOf(id) < 0) ids.push(id);
    }
    const details = {};
    if (!ids.length) return details;
    try {
      const results = search.create({
        type: "item",
        filters: [["internalid", "anyof", ids]],
        columns: ITEM_COLUMNS
      }).run().getRange({ start: 0, end: 1000 }) || [];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const value = (name) => result.getValue({ name });
        details[textValue(result.id)] = {
          itemName: textValue(value("itemid")),
          displayName: textValue(value("displayname")),
          description: textValue(value("salesdescription")),
          itemTypeText: textValue(result.getText({ name: "type" }) || value("type")),
          itemWeight: numberValue(value("weight")),
          toPlt: numberValue(value("custitem_toplt")),
          toLyr: numberValue(value("custitem_tolyr")),
          toSec: numberValue(value("custitem_tosec")),
          toPcs: numberValue(value("custitem_topcs"))
        };
      }
    } catch (error) {
      log.debug("MBBS item search skipped", {
        itemCount: ids.length,
        name: error.name,
        message: error.message
      });
    }
    return details;
  }

  function mapRecordType(type) {
    const normalized = textValue(type).toLowerCase();
    if (normalized === record.Type.SALES_ORDER || normalized === "salesorder") return "salesorder";
    if (normalized === record.Type.PURCHASE_ORDER || normalized === "purchaseorder") return "purchaseorder";
    if (normalized === record.Type.TRANSFER_ORDER || normalized === "transferorder") return "transferorder";
    return normalized;
  }

  function transactionTypeForLoad(type) {
    if (type === "salesorder") return record.Type.SALES_ORDER;
    if (type === "purchaseorder") return record.Type.PURCHASE_ORDER;
    if (type === "transferorder") return record.Type.TRANSFER_ORDER;
    return type;
  }

  function sourceOrderLine(rec, line) {
    const value = Number(getLineValueSafe(rec, line, "line"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function buildLines(rec) {
    const count = rec.getLineCount({ sublistId: "item" }) || 0;
    const itemIds = [];
    for (let line = 0; line < count; line += 1) {
      itemIds.push(getLineValueSafe(rec, line, "item"));
    }
    const cache = itemDetailsMap(itemIds);
    const lines = [];
    for (let line = 0; line < count; line += 1) {
      const itemId = getLineValueSafe(rec, line, "item");
      if (!itemId) continue;
      if (!cache[itemId]) cache[itemId] = itemDetails(itemId);
      const item = cache[itemId] || {};
      const lineId = getLineValueSafe(rec, line, "lineuniquekey")
        || getLineValueSafe(rec, line, "line")
        || line + 1;
      const lineLocationId = getLineValueSafe(rec, line, "location")
        || getValueSafe(rec, "location");
      const lineLocationText = getLineTextSafe(rec, line, "location")
        || getTextSafe(rec, "location");
      const description = getLineValueSafe(rec, line, "description")
        || getLineValueSafe(rec, line, "memo")
        || item.description
        || "";
      lines.push({
        orderLine: sourceOrderLine(rec, line),
        lineId,
        lineUniqueKey: lineId,
        itemId,
        itemName: item.itemName || getLineTextSafe(rec, line, "item"),
        itemType: getLineValueSafe(rec, line, "itemtype"),
        itemTypeText: item.itemTypeText || getLineTextSafe(rec, line, "itemtype"),
        itemDescription: description,
        quantity: numberValue(getLineValueSafe(rec, line, "quantity")),
        signedQuantity: signedNumberValue(getLineValueSafe(rec, line, "quantity")),
        quantityCommitted: numberValue(getLineValueSafe(rec, line, "quantitycommitted")),
        quantityBackordered: numberValue(getLineValueSafe(rec, line, "quantitybackordered")),
        quantityShipRecv: numberValue(getLineValueSafe(rec, line, "quantityshiprecv")),
        quantityFulfilled: numberValue(getLineValueSafe(rec, line, "quantityfulfilled")),
        quantityReceived: numberValue(getLineValueSafe(rec, line, "quantityreceived")),
        rate: numberValue(getLineValueSafe(rec, line, "rate")),
        amount: numberValue(getLineValueSafe(rec, line, "amount")),
        closed: /^(t|true|yes|1)$/i.test(textValue(getLineValueSafe(rec, line, "isclosed"))),
        unit: getLineTextSafe(rec, line, "units"),
        itemWeight: item.itemWeight,
        locationId: lineLocationId,
        locationText: lineLocationText,
        custcol_plt: numberValue(getLineValueSafe(rec, line, "custcol_plt")),
        custcol_lyr: numberValue(getLineValueSafe(rec, line, "custcol_lyr")),
        custcol_sec: numberValue(getLineValueSafe(rec, line, "custcol_sec")),
        custcol_pcs: numberValue(getLineValueSafe(rec, line, "custcol_pcs")),
        to_plt: item.toPlt,
        to_lyr: item.toLyr,
        to_sec: item.toSec,
        to_pcs: item.toPcs,
        toPlt: item.toPlt,
        toLyr: item.toLyr,
        toSec: item.toSec,
        toPcs: item.toPcs,
        custitem_toplt: item.toPlt,
        custitem_tolyr: item.toLyr,
        custitem_tosec: item.toSec,
        custitem_topcs: item.toPcs
      });
    }
    return lines;
  }

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

  function buildPayload(target, overrides) {
    const type = target.type;
    const rec = record.load({
      type: transactionTypeForLoad(type),
      id: target.id,
      isDynamic: false
    });
    return {
      eventType: target.eventType,
      executionContext: textValue(runtime.executionContext),
      manualApproval: target.manualApproval === true,
      recordType: type,
      id: rec.id,
      tranid: getValueSafe(rec, "tranid"),
      trandate: getValueSafe(rec, "trandate"),
      createdDate: getValueSafe(rec, "createddate"),
      lastModifiedDate: getValueSafe(rec, "lastmodifieddate"),
      entityId: getValueSafe(rec, "entity"),
      entityText: getTextSafe(rec, "entity"),
      status: getValueSafe(rec, "orderstatus") || getValueSafe(rec, "status"),
      statusText: getTextSafe(rec, "status") || getTextSafe(rec, "orderstatus"),
      memo: type === "purchaseorder"
        ? getValueSafe(rec, "memo")
        : getValueSafe(rec, "custbody7") || getValueSafe(rec, "memo"),
      vendorReference: getValueSafe(rec, "otherrefnum"),
      expectedDeliveryDate: getValueSafe(rec, "custbody4"),
      foreignTotal: getValueSafe(rec, "foreigntotal") || getValueSafe(rec, "total"),
      locationId: getValueSafe(rec, "location"),
      locationText: getTextSafe(rec, "location"),
      sourceLocationId: getValueSafe(rec, "location"),
      sourceLocationText: getTextSafe(rec, "location"),
      destinationLocationId: getValueSafe(rec, "transferlocation"),
      destinationLocationText: getTextSafe(rec, "transferlocation"),
      transferLocationId: getValueSafe(rec, "transferlocation"),
      transferLocationText: getTextSafe(rec, "transferlocation"),
      deliveryMethodId: getValueSafe(rec, "custbody3"),
      deliveryMethodText: getTextSafe(rec, "custbody3"),
      lines: buildLines(rec),
      ...(overrides || {})
    };
  }

  function sendWebhook(target, diagnostic, overrides) {
    const script = runtime.getCurrentScript();
    try {
      const url = scriptParameter(script, PARAM_URLS);
      const secret = scriptParameter(script, PARAM_SECRETS);
      if (!url || !secret) {
        log.error("MBBS webhook missing parameters", {
          ...diagnostic,
          urlConfigured: Boolean(url),
          secretConfigured: Boolean(secret),
          acceptedUrlParameterIds: PARAM_URLS,
          acceptedSecretParameterIds: PARAM_SECRETS,
          urlParameters: parameterSnapshot(script, PARAM_URLS),
          secretParameters: parameterSnapshot(script, PARAM_SECRETS)
        });
        return;
      }

      const payload = buildPayload(target, overrides);
      const response = https.post({
        url,
        headers: {
          "Content-Type": "application/json",
          "x-mbbs-webhook-secret": secret
        },
        body: JSON.stringify(payload)
      });
      if (Number(response.code) < 200 || Number(response.code) >= 300) {
        log.error("MBBS webhook failed", {
          ...diagnostic,
          code: response.code,
          body: textValue(response.body).slice(0, 1000),
          tranid: payload.tranid
        });
        return;
      }
      log.audit("MBBS webhook sent", {
        ...diagnostic,
        code: response.code,
        tranid: payload.tranid,
        status: payload.status,
        statusText: payload.statusText
      });
    } catch (error) {
      // Webhook failures are logged but must not cancel the user's approval,
      // stop the order page from opening, or fail a fulfillment/receipt save.
      log.error("MBBS webhook exception", {
        ...diagnostic,
        name: error.name,
        message: error.message,
        stack: error.stack
      });
    }
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
