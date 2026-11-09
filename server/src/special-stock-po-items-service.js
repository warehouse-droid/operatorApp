import {
  addSpecialPurchaseOrderItem, claimSpecialPurchaseOrderItemRetry, failSpecialPurchaseOrderItemSync,
  finishSpecialPurchaseOrderItemSync, getSpecialStockCase, readSpecialPurchaseOrderItemPlan, saveSpecialPurchaseOrderItemPlan
} from './special-stock-request-repository.js';
import {
  applySpecialPurchaseItemAppendInNetSuite, prepareSpecialPurchaseItemAppendInNetSuite, resolveSpecialPurchaseUnitsFromNetSuite
} from './netsuite.js';

/** SCM-added PO items after the PO exists. A PO this application created for the request is
 * updated in NetSuite; the SO and the Sales process are never involved. */
export function createSpecialPurchaseItemService(dependencies = {}) {
  const deps = {
    getCase: getSpecialStockCase, addItem: addSpecialPurchaseOrderItem, claimRetry: claimSpecialPurchaseOrderItemRetry,
    readPlan: readSpecialPurchaseOrderItemPlan, savePlan: saveSpecialPurchaseOrderItemPlan,
    finish: finishSpecialPurchaseOrderItemSync, fail: failSpecialPurchaseOrderItemSync,
    resolveUnits: resolveSpecialPurchaseUnitsFromNetSuite,
    preparePlan: prepareSpecialPurchaseItemAppendInNetSuite, applyPlan: applySpecialPurchaseItemAppendInNetSuite,
    ...dependencies
  };

  /** @param {number|string} caseId @param {number} lineId @param {{operatorId?:string}} context */
  async function sync(caseId, lineId, context) {
    try {
      let plan = await deps.readPlan(caseId, lineId);
      if (!plan) {
        const detail = await deps.getCase(caseId, { audience: 'scm' });
        const line = detail.purchaseOrderLines.find(/** @param {Record<string,any>} row */ row => row.id === lineId);
        if (!line || !detail.purchaseOrderId) throw Object.assign(Error('The added PO item or its PO was not found.'), { status: 409, code: 'SPECIAL_PO_ITEM_NOT_FOUND' });
        const [resolved] = await deps.resolveUnits([line]);
        plan = await deps.preparePlan({ purchaseOrderId: detail.purchaseOrderId, caseId: detail.id, line: { ...line, unitId: resolved?.unitId ?? null } });
        await deps.savePlan(caseId, lineId, plan);
      }
      const result = await deps.applyPlan(plan);
      return await deps.finish(caseId, lineId, result, context);
    } catch (error) {
      await deps.fail(caseId, lineId, /** @type {Error} */ (error).message, context).catch(() => null);
      throw error;
    }
  }

  /** @param {number|string} caseId @param {{expectedRevision?:unknown,line?:Record<string,any>}} input @param {{operatorId?:string}} context */
  async function addItem(caseId, input = {}, context = {}) {
    const before = await deps.getCase(caseId, { audience: 'scm' });
    // Reject an unknown UOM before anything is saved when the item goes onto the NetSuite PO.
    if (before.purchaseOrderCreatedByApp && !before.purchaseOrderSkipped && input.line && typeof input.line === 'object') {
      await deps.resolveUnits([{ ...input.line, itemId: Number(input.line.itemId) }]);
    }
    const added = await deps.addItem(caseId, input, context);
    if (!added.sync) return added.detail;
    return sync(caseId, added.lineId, context);
  }

  /** @param {number|string} caseId @param {number|string} lineId @param {{expectedRevision?:unknown}} input @param {{operatorId?:string}} context */
  async function retryItem(caseId, lineId, input = {}, context = {}) {
    await deps.claimRetry(caseId, lineId, input, context);
    return sync(caseId, Number(lineId), context);
  }

  return { addItem, retryItem };
}

export const addSpecialPurchaseItem = (/** @type {any[]} */ ...args) => createSpecialPurchaseItemService().addItem(...args);
export const retrySpecialPurchaseItem = (/** @type {any[]} */ ...args) => createSpecialPurchaseItemService().retryItem(...args);
