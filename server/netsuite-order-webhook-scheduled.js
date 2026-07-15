/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 *
 * Script ID: customscript_mbbs_order_webhook_worker
 * Create one or more Not Scheduled deployments so NetSuite can queue workers.
 *
 * Script parameters passed by netsuite-order-webhook-user-event.js:
 * - custscriptmbbs_wh_record_type
 * - custscriptmbbs_wh_record_id
 * - custscriptmbbs_wh_event_type
 * - custscriptmbbs_wh_url
 * - custscriptmbbs_wh_secret
 */
define(["N/https", "N/log", "N/record", "N/runtime", "N/search"], (https, log, record, runtime, search) => {
  const PARAMS = {
    recordType: "custscriptmbbs_wh_record_type",
    recordId: "custscriptmbbs_wh_record_id",
    eventType: "custscriptmbbs_wh_event_type",
    url: "custscriptmbbs_wh_url",
    secret: "custscriptmbbs_wh_secret"
  };

  function textValue(value) {
    return value == null ? "" : String(value);
  }

  function numberValue(value) {
    const number = Number(String(value == null ? "" : value).replace(/,/g, ""));
    return Number.isFinite(number) ? Math.abs(number) : 0;
  }

  function signedNumberValue(value) {
    const number = Number(String(value == null ? "" : value).replace(/,/g, ""));
    return Number.isFinite(number) ? number : 0;
  }

  function scalarLookup(value) {
    if (Array.isArray(value)) return value[0]?.text || value[0]?.value || "";
    if (value && typeof value === "object") return value.text || value.value || "";
    return value == null ? "" : value;
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
        columns: [
          "itemid",
          "displayname",
          "salesdescription",
          "type",
          "weight",
          "custitem_toplt",
          "custitem_tolyr",
          "custitem_tosec",
          "custitem_topcs"
        ]
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
        toPcs: numberValue(scalarLookup(fields.custitem_topcs)),
        custitem_toplt: numberValue(scalarLookup(fields.custitem_toplt)),
        custitem_tolyr: numberValue(scalarLookup(fields.custitem_tolyr)),
        custitem_tosec: numberValue(scalarLookup(fields.custitem_tosec)),
        custitem_topcs: numberValue(scalarLookup(fields.custitem_topcs))
      };
    } catch (error) {
      log.debug("MBBS item lookup skipped", { itemId, message: error.message });
      return {};
    }
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

  function buildLines(rec) {
    const count = rec.getLineCount({ sublistId: "item" }) || 0;
    const cache = {};
    const lines = [];
    for (let line = 0; line < count; line += 1) {
      const itemId = getLineValueSafe(rec, line, "item");
      if (!itemId) continue;
      if (!cache[itemId]) cache[itemId] = itemDetails(itemId);
      const item = cache[itemId] || {};
      const lineId = getLineValueSafe(rec, line, "lineuniquekey")
        || getLineValueSafe(rec, line, "line")
        || line + 1;
      const lineLocationId = getLineValueSafe(rec, line, "location") || getValueSafe(rec, "location");
      const lineLocationText = getLineTextSafe(rec, line, "location") || getTextSafe(rec, "location");
      const description = getLineValueSafe(rec, line, "description")
        || getLineValueSafe(rec, line, "memo")
        || item.description
        || "";
      lines.push({
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
        custitem_toplt: item.custitem_toplt,
        custitem_tolyr: item.custitem_tolyr,
        custitem_tosec: item.custitem_tosec,
        custitem_topcs: item.custitem_topcs
      });
    }
    return lines;
  }

  function buildPayload({ recordType, recordId, eventType }) {
    const type = mapRecordType(recordType);
    const rec = record.load({
      type: transactionTypeForLoad(type),
      id: recordId,
      isDynamic: false
    });
    return {
      eventType,
      recordType: type,
      id: rec.id,
      tranid: getValueSafe(rec, "tranid"),
      trandate: getValueSafe(rec, "trandate"),
      createdDate: getValueSafe(rec, "createddate"),
      entityId: getValueSafe(rec, "entity"),
      entityText: getTextSafe(rec, "entity"),
      status: getValueSafe(rec, "orderstatus") || getValueSafe(rec, "status"),
      statusText: getTextSafe(rec, "status") || getTextSafe(rec, "orderstatus"),
      memo: getValueSafe(rec, "custbody7") || getValueSafe(rec, "memo"),
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
      lines: buildLines(rec)
    };
  }

  function execute() {
    const script = runtime.getCurrentScript();
    const recordType = textValue(script.getParameter({ name: PARAMS.recordType })).trim();
    const recordId = textValue(script.getParameter({ name: PARAMS.recordId })).trim();
    const eventType = textValue(script.getParameter({ name: PARAMS.eventType })).trim();
    const url = textValue(script.getParameter({ name: PARAMS.url })).trim();
    const secret = textValue(script.getParameter({ name: PARAMS.secret })).trim();

    if (!recordType || !recordId || !url || !secret) {
      log.error("MBBS webhook worker missing parameters", {
        recordTypeConfigured: Boolean(recordType),
        recordIdConfigured: Boolean(recordId),
        eventTypeConfigured: Boolean(eventType),
        urlConfigured: Boolean(url),
        secretConfigured: Boolean(secret)
      });
      return;
    }

    try {
      const payload = buildPayload({ recordType, recordId, eventType });
      const response = https.post({
        url,
        headers: {
          "Content-Type": "application/json",
          "x-mbbs-webhook-secret": secret
        },
        body: JSON.stringify(payload)
      });
      if (Number(response.code) < 200 || Number(response.code) >= 300) {
        throw new Error(`Webhook returned ${response.code}: ${textValue(response.body).slice(0, 1000)}`);
      }
      log.audit("MBBS webhook sent", {
        code: response.code,
        tranid: payload.tranid,
        recordType: payload.recordType,
        eventType
      });
    } catch (error) {
      log.error("MBBS webhook worker failed", {
        recordType,
        recordId,
        eventType,
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  return { execute };
});
