// @ts-check
import { operatorStepHasKits } from './operator-netsuite-posting-kits.js';
import { fulfillmentInventoryLocations } from './item-fulfillment-parts-domain.js';
import { verifyPurchaseReceiptWithCharges } from './operator-netsuite-receipt-charges.js';

const PAIRS = ['PO:IR', 'SO:IF', 'TO:IF', 'TO:IR'];
/** @type {Record<string,string>} */
const SOURCES = { PO: 'purchaseorder', SO: 'salesorder', TO: 'transferorder' };
/** @type {Record<string,string>} */
const TARGETS = { IR: 'itemreceipt', IF: 'itemfulfillment' };
const PACKS = ['custcol_plt', 'custcol_lyr', 'custcol_sec', 'custcol_pcs'];
const BODY = ['externalId', 'memo', 'custbody9', 'inventoryLocation', 'shipStatus', 'item'];
const LINE = ['orderLine', 'itemReceive', 'quantity', 'location', ...PACKS];

/** @param {any} value @param {string[]} allowed */
function onlyKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key));
}
/** Native routing is decided before a POST; unsupported fields are never dropped.
 * @param {any} step */
function supported(step) {
  const payload = step.payload;
  if (!PAIRS.includes(`${step.sourceOrderKind}:${step.transactionType}`) || operatorStepHasKits(step)
    || !onlyKeys(payload, BODY) || !onlyKeys(payload.item, ['items'])) { return false; }
  const items = payload.item.items;
  return Array.isArray(items) && items.length > 0 && items.length <= 1000
    && items.every(item => onlyKeys(item, LINE))
    && !(step.sourceOrderKind === 'SO' && fulfillmentInventoryLocations(payload).length > 1);
}
/** @param {any} settings */
function target(settings) {
  const url = new URL(settings.url);
  const account = String(settings.accountId || '').toLowerCase().replaceAll('_', '-');
  if (url.protocol !== 'https:' || url.hostname !== `${account}.restlets.api.netsuite.com`
    || url.pathname !== '/app/site/hosting/restlet.nl' || url.username || url.password || url.hash || url.port) {
    throw new Error('The IF/IR RESTlet URL must belong to the configured NetSuite account.');
  }
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !['script', 'deploy'].every(key => url.searchParams.getAll(key).length === 1
    && /^[A-Za-z0-9_]+$/.test(url.searchParams.get(key) || ''))) {
    throw new Error('The IF/IR RESTlet URL requires exactly one script and deployment.');
  }
  return url.toString();
}
/** @param {any} value */
function positiveId(value) {
  return ['number', 'string'].includes(typeof value) && /^[1-9]\d*$/.test(String(value))
    && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}
/** @param {string} text */
function decode(text) {
  try { const result = JSON.parse(text); return typeof result === 'string' ? JSON.parse(result) : result; }
  catch { return null; }
}
/** @param {string} message @param {any} [data] */
function unverified(message, data = {}) {
  return Object.assign(new Error(message), { code: 'IFIR_RESPONSE_UNVERIFIED', status: 503,
    ambiguous: true, postingNotAttempted: false, requiresReconciliation: true, id: positiveId(data?.id) });
}
/** @param {any} data */
function beforeSave(data) {
  return data?.ok === false && data.contractVersion === 1 && data.complete === false
    && data.id === null && data.ambiguous === false && data.requiresReconciliation === false
    && data.postingNotAttempted === true && ['validation', 'duplicate_check', 'transform'].includes(data.stage);
}
/** @param {any} data */
function scriptFailure(data) {
  const notAttempted = beforeSave(data);
  return Object.assign(new Error(String(data.message || 'NetSuite IR/IF posting failed.')), {
    code: String(data.code || 'IFIR_FAILED'), status: notAttempted ? 409 : 503,
    netsuiteResponseReceived: true, ambiguous: !notAttempted, postingNotAttempted: notAttempted,
    requiresReconciliation: !notAttempted, id: positiveId(data.id), stage: data.stage
  });
}
/** @param {any} data */
function completed(data) {
  return data?.ok === true && data.contractVersion === 1 && data.complete === true
    && data.requiresReconciliation === false && ['created', 'existing'].includes(data.outcome);
}
/** @param {any} data */
function assertEnvelope(data) {
  if (!completed(data) || !positiveId(data.id) || positiveId(data.record?.id) !== positiveId(data.id)
    || typeof data.tranId !== 'string' || !data.tranId.trim() || data.record.tranId !== data.tranId) {
    throw unverified('The RESTlet returned incomplete or inconsistent transaction evidence.', data);
  }
}
/** @param {any} step @param {any} data */
function assertSource(step, data) {
  if (data.record.recordType !== TARGETS[step.transactionType] || data.record.transactionType !== step.transactionType
    || positiveId(data.source?.id) !== positiveId(step.sourceNetSuiteId)
    || data.source.sourceOrderKind !== step.sourceOrderKind || data.source.recordType !== SOURCES[step.sourceOrderKind]
    || !Array.isArray(data.source.lines)) {
    throw unverified('The RESTlet source or transaction type does not match this posting.', data);
  }
}
/** @param {any} step @param {any} data */
function assertPacks(step, data) {
  // This account stores these columns on IF, not IR; never echo request values.
  if (step.transactionType !== 'IF') { return; }
  for (const line of step.payload.item.items.filter((/** @type {any} */ item) => item.itemReceive === true)) {
    const saved = data.record.item.items.find((/** @type {any} */ item) => Number(item.orderLine) === Number(line.orderLine));
    for (const field of PACKS) {
      if (line[field] !== undefined && (saved?.[field] === null || saved?.[field] === undefined
        || !Number.isFinite(Number(saved[field])) || Math.abs(Number(saved[field]) - Number(line[field])) > 0.000001)) {
        throw unverified(`The saved package quantity ${field} for line ${line.orderLine} does not match.`, data);
      }
    }
  }
}
/** @param {any} step @param {any} result @param {string|undefined} quantityPolicy */
function accepted(step, result, quantityPolicy) {
  const data = decode(result.text);
  if (!result.response.ok) { throw unverified(`NetSuite RESTlet returned HTTP ${result.response.status}.`, data); }
  if (data?.ok === false && data.contractVersion === 1) {
    if (beforeSave(data) && data.stage === 'transform'
      && ['IFIR_UNSUPPORTED_KIT', 'IFIR_UNSUPPORTED_INVENTORY_DETAIL'].includes(data.code)) { return null; }
    throw scriptFailure(data);
  }
  assertEnvelope(data);
  if (quantityPolicy && data.quantityPolicy !== quantityPolicy) {
    throw unverified('The RESTlet did not acknowledge the requested quantity policy.', data);
  }
  assertSource(step, data);
  verifyPurchaseReceiptWithCharges(step, data.record, data.source);
  assertPacks(step, data);
  return data;
}

/** One POST only. Null explicitly means native routing is safe before a save.
 * @param {{settings:()=>any,getToken:()=>Promise<string>,request:Function,mutate:Function}} dependencies */
export function createIfirPostingClient({ settings, getToken, request, mutate }) {
  return async (/** @type {any} */ step) => {
    const configured = await settings();
    if (configured.enabled !== true || !supported(step)) { return null; }
    const quantityPolicy = configured.quantityPolicyEnabled === true ? 'sqft_remaining_v1' : undefined;
    if (!quantityPolicy && (step.lineSnapshot || []).some((/** @type {any} */ line) => line.quantityCheckDeferred === true)) {
      return null;
    }
    let url, token;
    try { url = target(configured); token = await getToken(); }
    catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
        code: 'IFIR_CONFIGURATION_UNAVAILABLE', status: 503, postingNotAttempted: true, ambiguous: false
      });
    }
    return mutate(async () => {
      try {
        const result = await request(url, { method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'post', sourceOrderKind: step.sourceOrderKind,
            transactionType: step.transactionType, sourceNetSuiteId: step.sourceNetSuiteId, payload: step.payload,
            ...(quantityPolicy ? { quantityPolicy } : {}) }) });
        return accepted(step, result, quantityPolicy);
      } catch (error) {
        if (error && typeof error === 'object') {
          if (!('postingNotAttempted' in error) || error.postingNotAttempted !== true) {
            Object.assign(error, { ambiguous: true, requiresReconciliation: true });
          }
          throw error;
        }
        throw unverified(String(error));
      }
    });
  };
}
