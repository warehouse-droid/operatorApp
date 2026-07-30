/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Standalone reconciliation webhook for:
 * - Item Fulfillment (Transfer Order only)
 * - Item Receipt (Purchase Order and Transfer Order only)
 *
 * Deploy this script separately from the existing SO/PO/TO order webhook.
 *
 * Script parameters:
 * - custscriptmbbs_ifir_webhook_url
 * - custscriptmbbs_ifir_hmac_secret
 *
 * `custscriptmbbs_ifir_hmac_secret` is the script ID of a NetSuite API Secret,
 * not the secret value itself. The same secret value must be configured in the
 * receiving application.
 */
define([
  "N/crypto",
  "N/crypto/random",
  "N/encode",
  "N/https",
  "N/log",
  "N/record",
  "N/runtime",
  "N/search"
], (crypto, random, encode, https, log, record, runtime, search) => {
  const SCHEMA_VERSION = "mbbs.ifir.reconciliation.v1";
  const PARAMS = {
    url: "custscriptmbbs_ifir_webhook_url",
    hmacSecret: "custscriptmbbs_ifir_hmac_secret"
  };
  const SUPPORTED_SOURCE_TYPES = new Set(["purchaseorder", "transferorder"]);

  function textValue(value) {
    return value == null ? "" : String(value).trim();
  }

  function idValue(value) {
    const text = textValue(value);
    return text || null;
  }

  function numberValue(value) {
    if (value == null || textValue(value) === "") return null;
    const parsed = Number(String(value).replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function booleanValue(value, fallback = false) {
    if (value == null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    const normalized = textValue(value).toLowerCase();
    if (["t", "true", "yes", "y", "1"].includes(normalized)) return true;
    if (["f", "false", "no", "n", "0"].includes(normalized)) return false;
    return Boolean(value);
  }

  function jsonValue(value) {
    if (value == null || value === "") return null;
    if (value && typeof value.toISOString === "function") {
      try {
        return value.toISOString();
      } catch (error) {
        // Fall through to a string representation.
      }
    }
    if (["string", "number", "boolean"].includes(typeof value)) return value;
    return String(value);
  }

  function getValueSafe(rec, fieldId) {
    try {
      return rec.getValue({ fieldId });
    } catch (error) {
      return null;
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
      return null;
    }
  }

  function getLineTextSafe(rec, line, fieldId) {
    try {
      return rec.getSublistText({ sublistId: "item", fieldId, line });
    } catch (error) {
      return "";
    }
  }

  function firstValue(...values) {
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] != null && textValue(values[index]) !== "") return values[index];
    }
    return null;
  }

  function locationValue(id, text) {
    return {
      internalId: idValue(id),
      name: textValue(text) || null
    };
  }

  function recordLocation(rec, fieldId) {
    return locationValue(getValueSafe(rec, fieldId), getTextSafe(rec, fieldId));
  }

  function normalizeEventRecordType(value) {
    const normalized = textValue(value).toLowerCase().replace(/[^a-z]/g, "");
    if (normalized === "itemfulfillment") return "itemfulfillment";
    if (normalized === "itemreceipt") return "itemreceipt";
    return "";
  }

  function normalizeSourceRecordType(value, text) {
    const normalized = `${textValue(value)} ${textValue(text)}`
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (normalized.includes("transferorder") || normalized.includes("trnfrord")) {
      return "transferorder";
    }
    if (normalized.includes("purchaseorder") || normalized.includes("purchord")) {
      return "purchaseorder";
    }
    if (normalized.includes("salesorder") || normalized.includes("salesord")) {
      return "salesorder";
    }
    if (normalized.includes("returnauthorization") || normalized.includes("rtnauth")) {
      return "returnauthorization";
    }
    return "";
  }

  function normalizeAction(context) {
    const sourceEventType = textValue(context.type).toLowerCase();
    const createEvent = textValue(context.UserEventType.CREATE).toLowerCase() || "create";
    const deleteEvent = textValue(context.UserEventType.DELETE).toLowerCase() || "delete";
    if (sourceEventType === createEvent || sourceEventType === "create") {
      return "create";
    }
    if (sourceEventType === deleteEvent || sourceEventType === "delete") {
      return "delete";
    }

    const editEvents = new Set([
      "edit",
      "xedit",
      "pack",
      "ship",
      textValue(context.UserEventType.EDIT).toLowerCase(),
      textValue(context.UserEventType.XEDIT).toLowerCase(),
      textValue(context.UserEventType.PACK).toLowerCase(),
      textValue(context.UserEventType.SHIP).toLowerCase()
    ]);
    return editEvents.has(sourceEventType) ? "edit" : "";
  }

  function recordTypeForLoad(type) {
    if (type === "itemfulfillment") return record.Type.ITEM_FULFILLMENT;
    if (type === "itemreceipt") return record.Type.ITEM_RECEIPT;
    return "";
  }

  function sourceRecordTypeForLoad(type) {
    if (type === "purchaseorder") return record.Type.PURCHASE_ORDER;
    if (type === "transferorder") return record.Type.TRANSFER_ORDER;
    return "";
  }

  function uniqueLocationList(lines) {
    const seen = new Set();
    const locations = [];
    lines.forEach((line) => {
      const location = line.location || {};
      const key = `${location.internalId || ""}|${location.name || ""}`;
      if (key === "|" || seen.has(key)) return;
      seen.add(key);
      locations.push(location);
    });
    return locations;
  }

  function sourceLineSnapshot(sourceRec) {
    if (!sourceRec) return [];
    const count = sourceRec.getLineCount({ sublistId: "item" }) || 0;
    const lines = [];
    for (let index = 0; index < count; index += 1) {
      lines.push({
        index,
        lineId: idValue(getLineValueSafe(sourceRec, index, "line")),
        lineUniqueKey: idValue(getLineValueSafe(sourceRec, index, "lineuniquekey")),
        itemId: idValue(getLineValueSafe(sourceRec, index, "item")),
        itemName: textValue(getLineTextSafe(sourceRec, index, "item")) || null,
        quantity: numberValue(getLineValueSafe(sourceRec, index, "quantity")),
        unitId: idValue(getLineValueSafe(sourceRec, index, "units")),
        unit: textValue(getLineTextSafe(sourceRec, index, "units")) || null,
        location: locationValue(
          getLineValueSafe(sourceRec, index, "location"),
          getLineTextSafe(sourceRec, index, "location")
        )
      });
    }
    return lines;
  }

  function uniqueIndex(lines, field) {
    const index = {};
    lines.forEach((line) => {
      const key = idValue(line[field]);
      if (!key) return;
      if (Object.prototype.hasOwnProperty.call(index, key)) {
        index[key] = null;
      } else {
        index[key] = line;
      }
    });
    return index;
  }

  function sourceLineIndexes(lines) {
    return {
      byLineId: uniqueIndex(lines, "lineId"),
      byLineUniqueKey: uniqueIndex(lines, "lineUniqueKey")
    };
  }

  function matchSourceLine(orderLine, indexes) {
    const key = idValue(orderLine);
    if (!key) return { line: null, matchedBy: null };
    if (indexes.byLineId[key]) {
      return { line: indexes.byLineId[key], matchedBy: "orderline_to_source_line_id" };
    }
    if (indexes.byLineUniqueKey[key]) {
      return {
        line: indexes.byLineUniqueKey[key],
        matchedBy: "orderline_to_source_line_unique_key"
      };
    }
    return { line: null, matchedBy: null };
  }

  function buildTransactionLines(rec, sourceLines) {
    const count = rec.getLineCount({ sublistId: "item" }) || 0;
    const indexes = sourceLineIndexes(sourceLines);
    const lines = [];

    for (let index = 0; index < count; index += 1) {
      const itemId = idValue(getLineValueSafe(rec, index, "item"));
      if (!itemId) continue;

      const orderLine = idValue(getLineValueSafe(rec, index, "orderline"));
      const sourceMatch = matchSourceLine(orderLine, indexes);
      const matchedSourceLine = sourceMatch.line;
      const quantity = numberValue(getLineValueSafe(rec, index, "quantity"));
      const includedRaw = getLineValueSafe(rec, index, "itemreceive");
      const isIncluded = booleanValue(includedRaw, true);
      const transactionUnitId = idValue(getLineValueSafe(rec, index, "units"));
      const transactionUnit = textValue(getLineTextSafe(rec, index, "units")) || null;

      lines.push({
        index,
        lineId: idValue(getLineValueSafe(rec, index, "line")),
        lineUniqueKey: idValue(getLineValueSafe(rec, index, "lineuniquekey")),
        orderLine,
        sourceLineId: matchedSourceLine?.lineId || orderLine,
        sourceLineKey: matchedSourceLine?.lineUniqueKey || orderLine,
        sourceLineUniqueKey: matchedSourceLine?.lineUniqueKey || null,
        sourceLineMatch: sourceMatch.matchedBy,
        itemId,
        itemName: textValue(getLineTextSafe(rec, index, "item")) || null,
        itemType: idValue(getLineValueSafe(rec, index, "itemtype")),
        itemTypeText: textValue(getLineTextSafe(rec, index, "itemtype")) || null,
        description: textValue(firstValue(
          getLineValueSafe(rec, index, "description"),
          getLineValueSafe(rec, index, "memo")
        )) || null,
        quantity,
        unitId: transactionUnitId || matchedSourceLine?.unitId || null,
        unit: transactionUnit || matchedSourceLine?.unit || null,
        unitSource: transactionUnitId || transactionUnit
          ? "if_ir"
          : matchedSourceLine?.unitId || matchedSourceLine?.unit
            ? "source_order"
            : null,
        location: locationValue(
          getLineValueSafe(rec, index, "location"),
          getLineTextSafe(rec, index, "location")
        ),
        isIncluded,
        reconciliationRelevant: isIncluded && quantity != null && quantity !== 0,
        isClosed: booleanValue(getLineValueSafe(rec, index, "isclosed"), false)
      });
    }

    return lines;
  }

  function searchSourceTransaction(sourceId) {
    if (!sourceId) return null;
    const result = search.create({
      type: "transaction",
      filters: [
        ["internalid", "anyof", sourceId],
        "AND",
        ["mainline", "is", "T"]
      ],
      columns: ["internalid", "tranid", "type", "status"]
    }).run().getRange({ start: 0, end: 1 })[0];

    if (!result) return null;
    const rawType = result.getValue({ name: "type" });
    const typeText = result.getText({ name: "type" });
    return {
      internalId: idValue(result.getValue({ name: "internalid" })) || idValue(sourceId),
      reference: textValue(result.getValue({ name: "tranid" })) || null,
      recordType: normalizeSourceRecordType(rawType, typeText),
      recordTypeCode: textValue(rawType) || null,
      recordTypeText: textValue(typeText) || null,
      statusText: textValue(
        result.getText({ name: "status" }) || result.getValue({ name: "status" })
      ) || null
    };
  }

  function loadSourceTransaction(sourceSummary) {
    const loadType = sourceRecordTypeForLoad(sourceSummary?.recordType);
    if (!loadType || !sourceSummary?.internalId) return null;
    return record.load({
      type: loadType,
      id: sourceSummary.internalId,
      isDynamic: false
    });
  }

  function buildCreatedFrom(rec) {
    const sourceId = idValue(getValueSafe(rec, "createdfrom"));
    const sourceText = textValue(getTextSafe(rec, "createdfrom")) || null;
    if (!sourceId) {
      return {
        summary: {
          internalId: null,
          reference: sourceText,
          recordType: null,
          recordTypeCode: null,
          recordTypeText: null,
        status: { value: null, text: null },
        locations: {
          source: locationValue(null, null),
          destination: locationValue(null, null),
          lines: []
        }
      },
      sourceLines: []
      };
    }

    let searched = null;
    try {
      searched = searchSourceTransaction(sourceId);
    } catch (error) {
      log.error("MBBS IF/IR source lookup failed", {
        sourceId,
        sourceText,
        name: error.name,
        message: error.message
      });
    }

    const summary = {
      internalId: searched?.internalId || sourceId,
      reference: searched?.reference || sourceText,
      recordType: searched?.recordType || null,
      recordTypeCode: searched?.recordTypeCode || null,
      recordTypeText: searched?.recordTypeText || null,
      status: {
        value: null,
        text: searched?.statusText || null
      },
      locations: {
        source: locationValue(null, null),
        destination: locationValue(null, null),
        lines: []
      }
    };

    let sourceRec = null;
    try {
      sourceRec = loadSourceTransaction(summary);
    } catch (error) {
      log.error("MBBS IF/IR source record load failed", {
        sourceId,
        sourceReference: summary.reference,
        sourceRecordType: summary.recordType,
        name: error.name,
        message: error.message
      });
    }

    if (!sourceRec) return { summary, sourceLines: [] };

    summary.reference = textValue(getValueSafe(sourceRec, "tranid")) || summary.reference;
    summary.status = {
      value: jsonValue(firstValue(
        getValueSafe(sourceRec, "statusref"),
        getValueSafe(sourceRec, "status"),
        getValueSafe(sourceRec, "orderstatus")
      )),
      text: textValue(firstValue(
        getTextSafe(sourceRec, "statusref"),
        getTextSafe(sourceRec, "status"),
        getTextSafe(sourceRec, "orderstatus")
      )) || summary.status.text
    };
    const sourceLines = sourceLineSnapshot(sourceRec);
    summary.locations = {
      source: recordLocation(sourceRec, "location"),
      destination: summary.recordType === "transferorder"
        ? recordLocation(sourceRec, "transferlocation")
        : recordLocation(sourceRec, "location"),
      lines: uniqueLocationList(sourceLines)
    };

    return {
      summary,
      sourceLines
    };
  }

  function buildStatus(rec) {
    return {
      value: jsonValue(firstValue(
        getValueSafe(rec, "statusref"),
        getValueSafe(rec, "status")
      )),
      text: textValue(firstValue(
        getTextSafe(rec, "statusref"),
        getTextSafe(rec, "status")
      )) || null,
      shipStatus: {
        value: jsonValue(getValueSafe(rec, "shipstatus")),
        text: textValue(getTextSafe(rec, "shipstatus")) || null
      }
    };
  }

  function buildRecordSnapshot(rec, eventRecordType, action) {
    const createdFrom = buildCreatedFrom(rec);
    const lines = buildTransactionLines(rec, createdFrom.sourceLines);
    return {
      internalId: idValue(rec.id),
      recordType: eventRecordType,
      transactionRef: textValue(getValueSafe(rec, "tranid")) || null,
      transactionDate: jsonValue(getValueSafe(rec, "trandate")),
      createdDate: jsonValue(getValueSafe(rec, "createddate")),
      lastModifiedDate: jsonValue(getValueSafe(rec, "lastmodifieddate")),
      status: buildStatus(rec),
      createdFrom: createdFrom.summary,
      memo: textValue(getValueSafe(rec, "memo")) || null,
      locations: {
        actual: recordLocation(rec, "location"),
        transfer: recordLocation(rec, "transferlocation"),
        lines: uniqueLocationList(lines)
      },
      deleted: action === "delete",
      lines
    };
  }

  function completeRecordForContext(context, eventRecordType, action) {
    if (action === "delete") return context.oldRecord;
    const recordId = context.newRecord && context.newRecord.id;
    const loadType = recordTypeForLoad(eventRecordType);
    if (!recordId || !loadType) return null;
    return record.load({
      type: loadType,
      id: recordId,
      isDynamic: false
    });
  }

  function eventIdFor(recordType, recordId, action, eventTimeEpochMs) {
    try {
      return random.generateUUID();
    } catch (error) {
      const script = runtime.getCurrentScript();
      return [
        "mbbs-ifir",
        recordType || "record",
        recordId || "unknown",
        action || "event",
        eventTimeEpochMs,
        script.deploymentId || "deployment"
      ].join("-");
    }
  }

  function signBody({ apiSecretScriptId, timestamp, eventId, body }) {
    const key = crypto.createSecretKey({
      secret: apiSecretScriptId,
      encoding: encode.Encoding.UTF_8
    });
    const hmac = crypto.createHmac({
      algorithm: crypto.HashAlg.SHA256,
      key
    });
    hmac.update({
      input: `${timestamp}\n${eventId}\n${body}`,
      inputEncoding: encode.Encoding.UTF_8
    });
    return hmac.digest({ outputEncoding: encode.Encoding.HEX });
  }

  function afterSubmit(context) {
    const action = normalizeAction(context);
    if (!action) return;

    const contextRecord = action === "delete" ? context.oldRecord : context.newRecord;
    const eventRecordType = normalizeEventRecordType(contextRecord && contextRecord.type);
    if (!eventRecordType) return;

    const script = runtime.getCurrentScript();
    const url = textValue(script.getParameter({ name: PARAMS.url }));
    const apiSecretScriptId = textValue(script.getParameter({ name: PARAMS.hmacSecret }));
    const eventTimeEpochMs = Date.now();
    const eventTime = new Date(eventTimeEpochMs).toISOString();
    const initialRecordId = idValue(contextRecord && contextRecord.id);
    const eventId = eventIdFor(eventRecordType, initialRecordId, action, eventTimeEpochMs);
    const sourceEventType = textValue(context.type).toLowerCase();

    try {
      if (!url || !apiSecretScriptId) {
        log.error("MBBS IF/IR webhook missing parameters", {
          eventId,
          eventRecordType,
          recordId: initialRecordId,
          action,
          scriptId: script.id,
          deploymentId: script.deploymentId,
          urlConfigured: Boolean(url),
          hmacSecretConfigured: Boolean(apiSecretScriptId),
          requiredParameters: PARAMS
        });
        return;
      }

      const completeRecord = completeRecordForContext(context, eventRecordType, action);
      if (!completeRecord) {
        log.error("MBBS IF/IR webhook record unavailable", {
          eventId,
          eventRecordType,
          recordId: initialRecordId,
          action,
          sourceEventType
        });
        return;
      }

      const snapshot = buildRecordSnapshot(completeRecord, eventRecordType, action);
      const sourceType = snapshot.createdFrom?.recordType;
      if (sourceType && !SUPPORTED_SOURCE_TYPES.has(sourceType)) {
        log.debug("MBBS IF/IR webhook skipped unrelated transaction", {
          eventId,
          eventRecordType,
          recordId: snapshot.internalId,
          transactionRef: snapshot.transactionRef,
          sourceRecordType: sourceType,
          sourceRecordId: snapshot.createdFrom?.internalId,
          sourceReference: snapshot.createdFrom?.reference
        });
        return;
      }

      const payload = {
        schemaVersion: SCHEMA_VERSION,
        eventId,
        eventTime,
        eventTimeEpochMs,
        action,
        sourceEventType,
        executionContext: textValue(runtime.executionContext) || null,
        tombstone: action === "delete"
          ? {
              deleted: true,
              deletedAt: eventTime,
              previousRecordInternalId: snapshot.internalId,
              previousTransactionRef: snapshot.transactionRef
            }
          : null,
        record: snapshot
      };
      const body = JSON.stringify(payload);
      const timestamp = String(Math.floor(eventTimeEpochMs / 1000));
      const signature = signBody({
        apiSecretScriptId,
        timestamp,
        eventId,
        body
      });
      const response = https.post({
        url,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "x-mbbs-ifir-event-id": eventId,
          "x-mbbs-ifir-timestamp": timestamp,
          "x-mbbs-ifir-signature": `sha256=${signature}`,
          "x-mbbs-ifir-signature-version": "v1"
        },
        body
      });

      const responseCode = Number(response.code);
      if (responseCode < 200 || responseCode >= 300) {
        log.error("MBBS IF/IR webhook HTTP failure", {
          eventId,
          eventRecordType,
          recordId: snapshot.internalId,
          transactionRef: snapshot.transactionRef,
          sourceRecordType: sourceType,
          sourceRecordId: snapshot.createdFrom?.internalId,
          action,
          responseCode: response.code,
          responseBody: textValue(response.body).slice(0, 1000)
        });
        return;
      }

      log.audit("MBBS IF/IR webhook delivered", {
        eventId,
        eventRecordType,
        recordId: snapshot.internalId,
        transactionRef: snapshot.transactionRef,
        sourceRecordType: sourceType,
        sourceRecordId: snapshot.createdFrom?.internalId,
        sourceReference: snapshot.createdFrom?.reference,
        action,
        responseCode: response.code,
        lineCount: snapshot.lines.length
      });
    } catch (error) {
      // This is an afterSubmit integration. Log the failure, but never throw:
      // the Item Fulfillment or Item Receipt must remain saved in NetSuite.
      log.error("MBBS IF/IR webhook delivery failed", {
        eventId,
        eventRecordType,
        recordId: initialRecordId,
        action,
        sourceEventType,
        scriptId: script.id,
        deploymentId: script.deploymentId,
        name: error.name,
        message: error.message,
        stack: error.stack
      });
    }
  }

  return { afterSubmit };
});
