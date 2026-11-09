/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Shared code of the MBBS order webhook: builds the order payload and sends
 * it to the app. Used by the order webhook User Event
 * (netsuite-order-webhook-user-event-direct.js) and the retry Scheduled
 * Script (netsuite-order-webhook-retry-scheduled.js). Upload it to the same
 * File Cabinet folder as both scripts, named exactly
 * netsuite-order-webhook-lib.js.
 *
 * When a send fails with a lost connection (closed, timed out) or a 408, 425,
 * 429 or 5xx response, the retry Scheduled Script (customscript_mbbs_webhook_retry)
 * is queued. It waits until 10 seconds after the failure, reloads the order,
 * and sends its current state again, up to 3 retries.
 */
define(["N/https", "N/log", "N/record", "N/runtime", "N/search", "N/task"], (https, log, record, runtime, search, task) => {
  const PARAM_URLS = [
    "custscriptmbbs_webhook_url",
    "custscript_mbbs_webhook_url",
    "custscript_mbbs_retry_url"
  ];
  const PARAM_SECRETS = [
    "custscriptwh_webhook_secret_i",
    "custscript_mbbs_webhook_secret",
    "custscript_webhook_secret_id",
    "custscript_mbbs_retry_secret"
  ];
  const RETRY_SCRIPT_ID = "customscript_mbbs_webhook_retry";
  const RETRY_JOB_PARAM = "custscript_mbbs_retry_job";
  const RETRY_DELAY_MS = 10 * 1000;
  const MAX_RETRY_ATTEMPTS = 3;

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

  function buildPayload(target, overrides) {
    const type = target.type;
    const rec = record.load({
      type: transactionTypeForLoad(type),
      id: target.id,
      isDynamic: false
    });
    return {
      eventType: target.eventType,
      // A retry keeps the original context so a resend of an unchanged order
      // is recognised by the app as a duplicate.
      executionContext: textValue(target.executionContext || runtime.executionContext),
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

  // 408/425/429 and 5xx (Cloudflare answers 502 or 52x while the app is
  // restarting) can succeed later. Other 4xx (wrong secret, rejected payload)
  // will not.
  function isRetryableCode(code) {
    return code === 408 || code === 425 || code === 429 || code >= 500;
  }

  function queueRetry(job, diagnostic) {
    try {
      const taskId = task.create({
        taskType: task.TaskType.SCHEDULED_SCRIPT,
        scriptId: RETRY_SCRIPT_ID,
        params: { [RETRY_JOB_PARAM]: JSON.stringify(job) }
      }).submit();
      log.audit("MBBS webhook retry queued", { ...diagnostic, attempt: job.attempt, taskId });
      return true;
    } catch (error) {
      log.error("MBBS webhook retry not queued", {
        ...diagnostic,
        attempt: job.attempt,
        recordType: job.recordType,
        recordId: job.id,
        tranid: job.tranid,
        name: error.name,
        message: error.message
      });
      return false;
    }
  }

  // Sends the target order's current state. attempt 0 is the original send,
  // 1..3 are retries. Never throws: a failed send must not cancel the
  // user's approval, stop the order page from opening, or fail a
  // fulfillment/receipt save.
  function sendWebhook(target, diagnostic, overrides, options) {
    const attempt = Number(options && options.attempt) || 0;
    const script = runtime.getCurrentScript();
    let url = "";
    let secret = "";
    let payload = null;
    try {
      url = scriptParameter(script, PARAM_URLS);
      secret = scriptParameter(script, PARAM_SECRETS);
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
        return { ok: false, retryQueued: false };
      }
      payload = buildPayload(target, overrides);
    } catch (error) {
      // The order could not be read, so sending it again would not help.
      log.error("MBBS webhook exception", {
        ...diagnostic,
        attempt,
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      return { ok: false, retryQueued: false };
    }

    try {
      const headers = {
        "Content-Type": "application/json",
        "x-mbbs-webhook-secret": secret
      };
      if (attempt) headers["x-mbbs-webhook-retry"] = String(attempt);
      const response = https.post({ url, headers, body: JSON.stringify(payload) });
      const code = Number(response.code);
      if (code >= 200 && code < 300) {
        log.audit(attempt ? "MBBS webhook retry sent" : "MBBS webhook sent", {
          ...diagnostic,
          attempt,
          code: response.code,
          tranid: payload.tranid,
          status: payload.status,
          statusText: payload.statusText
        });
        return { ok: true, retryQueued: false };
      }
      log.error("MBBS webhook failed", {
        ...diagnostic,
        attempt,
        code: response.code,
        body: textValue(response.body).slice(0, 1000),
        tranid: payload.tranid
      });
      if (!isRetryableCode(code)) return { ok: false, retryQueued: false };
    } catch (error) {
      // Connection closed or timed out before the app answered.
      log.error("MBBS webhook exception", {
        ...diagnostic,
        attempt,
        name: error.name,
        message: error.message,
        stack: error.stack,
        tranid: payload.tranid
      });
    }

    if (attempt >= MAX_RETRY_ATTEMPTS) {
      log.error("MBBS webhook retry gave up", {
        ...diagnostic,
        attempts: attempt,
        recordType: target.type,
        recordId: target.id,
        tranid: payload.tranid
      });
      return { ok: false, retryQueued: false };
    }
    const retryQueued = queueRetry({
      recordType: target.type,
      id: target.id,
      eventType: target.eventType,
      manualApproval: target.manualApproval === true,
      executionContext: payload.executionContext,
      overrides: overrides || {},
      attempt: attempt + 1,
      failedAt: Date.now(),
      tranid: payload.tranid
    }, diagnostic);
    return { ok: false, retryQueued };
  }

  return {
    RETRY_JOB_PARAM,
    RETRY_DELAY_MS,
    MAX_RETRY_ATTEMPTS,
    textValue,
    getValueSafe,
    getTextSafe,
    getLineValueSafe,
    mapRecordType,
    buildPayload,
    sendWebhook
  };
});
