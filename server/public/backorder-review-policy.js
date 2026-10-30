/** @param {Record<string,any>} line */
export function hasBackorderScmReply(line) {
  return Boolean(line.supplyStatus && (line.stockCheckedAt || line.respondedAt || line.responseRevision > 0));
}

/** @param {Record<string,any>} line */
export function hasBackorderSalesReply(line) {
  return ['accepted', 'request_update', 'declined', 'closed'].includes(line.salesDecision);
}

/** An optional reference does not change the canonical order link or stage.
 * @param {Record<string,any>} detail */
export function canAttachBackorderSalesOrder(detail) {
  if (detail.stage === 'closed' || detail.status === 'cancelled'
      || ['closed', 'closure_pending'].includes(detail.closeStatus)) return false;
  const lines = /** @type {Array<Record<string,any>>} */ (detail.lines || []);
  if (lines.some(line => line.supplyStatus === 'already_ordered')) return true;
  return detail.stage !== 'completed' && !detail.operationallyComplete
    && lines.length > 0 && lines.every(hasBackorderScmReply);
}
