// @ts-check
import { isAmbiguousOperatorNetSuiteFailure } from './operator-netsuite-posting-service.js';
import { fulfillmentInventoryLocations, isMixedLocationRejection, splitItemFulfillmentPayload } from './item-fulfillment-parts-domain.js';

/** @param {string} message */
function uncertain(message) {
  return Object.assign(new Error(message), { code: 'IF_PART_UNVERIFIED', ambiguous: true });
}
/** @param {any} step */
const applicable = step => step.transactionType === 'IF' && step.sourceOrderKind === 'SO';
/** @param {any} step @param {any} part */
const partStep = (step, part) => ({ ...step, externalId: part.externalId, payload: part.payload });

/** @param {{adapter: any, repository: any}} dependencies */
export function createLocationAwareIFAdapter({ adapter, repository }) {
  /** @param {any} step */
  async function planFor(step) { return applicable(step) ? repository.get(step) : null; }

  /** @param {any} step @param {any} part */
  async function recoverPart(step, part) {
    const target = partStep(step, part);
    const record = part.transactionId
      ? await adapter.fetchById(target, part.transactionId)
      : await adapter.findByExternalId(target, true);
    if (!record) {return null;}
    adapter.verify(target, record);
    await repository.complete(part, record);
    return record;
  }

  /** @param {any} step @param {any} part */
  async function executePart(step, part) {
    const recovered = await recoverPart(step, part);
    if (recovered) {return recovered;}
    if (part.status === 'posted') {throw uncertain('A previously verified IF part is no longer readable.');}
    const claimed = await repository.claim(part);
    if (!claimed.fresh) {throw uncertain('The previous IF part attempt needs verification before retrying.');}
    const target = partStep(step, claimed);
    let remoteMayExist = false;
    try {
      const result = await adapter.transform(target);
      remoteMayExist = true;
      const record = result?.id ? await adapter.fetchById(target, Number(result.id))
        : await adapter.findByExternalId(target, true);
      if (!record) {throw uncertain('NetSuite returned no verifiable IF part.');}
      adapter.verify(target, record);
      await repository.complete(claimed, record);
      return record;
    } catch (error) {
      return recoverFailure(step, claimed, error, remoteMayExist);
    }
  }

  /** @param {any} step @param {any} claimed @param {any} error @param {boolean} remoteMayExist */
  async function recoverFailure(step, claimed, error, remoteMayExist) {
    const ambiguous = remoteMayExist || isAmbiguousOperatorNetSuiteFailure(error);
    if (ambiguous) {
      try {
        const found = await recoverPart(step, claimed);
        if (found) { return found; }
      } catch { /* Retain the original attempt and require recovery. */ }
    }
    await repository.fail(claimed, error, ambiguous);
    if (ambiguous && error && typeof error === 'object') { Object.assign(error, { ambiguous: true }); }
    throw error;
  }

  /** @param {any} step @param {any[]} records */
  function aggregate(step, records) {
    const fulfillmentParts = records.map(record => ({
      transactionType: 'IF', sourceOrderKind: 'SO', sourceNetSuiteId: step.sourceNetSuiteId,
      sourceOrderRef: step.sourceOrderRef || '', externalId: record.externalId ?? record.externalid,
      transactionId: Number(record.id), transactionRef: record.tranId ?? record.tranid ?? String(record.id),
      inventoryLocationIds: fulfillmentInventoryLocations(record), status: 'posted'
    }));
    return {
      id: Number(records[0].id), tranId: fulfillmentParts.map(part => part.transactionRef).join(', '),
      externalId: step.externalId, createdFromId: step.sourceNetSuiteId, transactionType: 'IF',
      item: { items: records.flatMap(record => (record.item?.items || record.items || [])
        .filter((/** @type {any} */ item) => item.itemReceive !== false && item.itemreceive !== false && Number(item.quantity) > 0)) },
      fulfillmentParts
    };
  }

  /** @param {any} step @param {any} plan @param {boolean} execute */
  async function resolvePlan(step, plan, execute) {
    const records = [];
    for (const part of plan.parts) {
      const record = execute ? await executePart(step, part) : await recoverPart(step, part);
      if (!record) {return null;}
      records.push(record);
    }
    if (!records.length) {throw uncertain('The IF split plan has no parts.');}
    const result = aggregate(step, records);
    adapter.verify(step, result);
    return result;
  }

  return {
    ...adapter,
    /** @param {any} step */
    async hasSplitPlan(step) { return Boolean(await planFor(step)); },
    /** @param {any} step */
    async parts(step) { return (await planFor(step))?.parts || []; },
    /** @param {any} step @param {boolean} [direct] */
    async findByExternalId(step, direct = false) {
      const plan = await planFor(step);
      return plan ? resolvePlan(step, plan, false) : adapter.findByExternalId(step, direct);
    },
    /** @param {any} step @param {number} id */
    async fetchById(step, id) {
      const plan = await planFor(step);
      return plan ? resolvePlan(step, plan, false) : adapter.fetchById(step, id);
    },
    /** @param {any} step */
    async transform(step) {
      let plan = await planFor(step);
      if (!plan) {
        try { return await adapter.transform(step); }
        catch (error) {
          if (!applicable(step) || !isMixedLocationRejection(error) || fulfillmentInventoryLocations(step.payload).length < 2) {throw error;}
          const original = await adapter.findByExternalId(step, true);
          if (original) { adapter.verify(step, original); return { id: Number(original.id) }; }
          plan = await repository.create(step, splitItemFulfillmentPayload(step.payload));
        }
      }
      try {
        const record = await resolvePlan(step, plan, true);
        if (!record) { throw uncertain('The IF parts could not be verified.'); }
        return { id: record.id };
      } catch (error) {
        // Keep the logical source claim until all parts are verified, even if
        // the current part was definitively rejected after another succeeded.
        if (error && typeof error === 'object') {Object.assign(error, { ambiguous: true, fulfillmentPartsPending: true });}
        throw error;
      }
    }
  };
}
