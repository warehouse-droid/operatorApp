// @ts-check

/** @returns {Error & {code: string, status: number}} */
function unresolved() {
  return Object.assign(new Error('The Transfer Order posting line could not be verified. Refresh the order before loading or receiving.'), {
    code: 'OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED', status: 409
  });
}

/** @param {unknown} value */
function positiveId(value) {
  const text = String(value ?? '');
  const number = Number(text);
  if (!/^\d+$/u.test(text) || !Number.isSafeInteger(number) || number <= 0) {throw unresolved();}
  return number;
}

/** @param {unknown} value */
function hidden(value) {
  if ([true, 'T', 'true'].includes(/** @type {any} */ (value))) {return true;}
  if ([false, 'F', 'false'].includes(/** @type {any} */ (value))) {return false;}
  throw unresolved();
}

/** @param {Record<string,any>} line @param {number} sourceId @param {number} itemId @param {boolean} outbound */
function physicalPostingLine(line,sourceId,itemId,outbound) {
  if (positiveId(line.id) !== sourceId || positiveId(line.item_id) !== itemId) {throw unresolved();}
  const quantity=Number(line.signed_quantity);
  if (!Number.isFinite(quantity) || (outbound ? quantity > 0 : quantity < 0)) {throw unresolved();}
  return {id:positiveId(line.order_line_number),key:positiveId(line.source_line_key),hidden:hidden(line.do_not_print_line)};
}

/** @param {{id:number,key:number,hidden:boolean}[]} lines @param {Record<string,any>} row */
function assertVisibleAnchor(lines,row) {
  const visible=lines.find(line=>!line.hidden);
  if(!visible){throw unresolved();}
  if(row.netsuite_order_line !== null && row.netsuite_order_line !== undefined
    && positiveId(row.netsuite_order_line)!==visible.id){throw unresolved();}
}

/**
 * A TO source item, its outbound inventory leg and its receipt leg have
 * different IDs. Select the observed physical leg; never offset a source ID.
 * @param {Record<string, any>} row
 * @param {{sourceNetSuiteId: number, stage: string}} context
 */
function verifiedPhysicalLines(row, {sourceNetSuiteId, stage}) {
  const evidence = row.raw;
  const physical = evidence?.physicalRows;
  const outbound = stage === 'outbound';
  if (!['outbound', 'receiving'].includes(stage) || evidence?.identityStatus !== 'exact'
      || !Array.isArray(physical) || physical.length !== (outbound ? 2 : 1)) {throw unresolved();}
  const sourceId = positiveId(sourceNetSuiteId), itemId = positiveId(row.item_id ?? row.itemId);
  const sourceKey = positiveId(row.source_line_key ?? row.sourceLineKey ?? row.line_id);
  const lines = physical.map(line => physicalPostingLine(line,sourceId,itemId,outbound));
  return {lines,sourceKey,outbound};
}

/** @param {Record<string,any>} row @param {{sourceNetSuiteId:number,stage:string}} context */
export function transferPostingOrderLine(row, context) {
  const {lines,sourceKey,outbound}=verifiedPhysicalLines(row,context);
  if (new Set(lines.map(line => line.id)).size !== lines.length
      || new Set(lines.map(line => line.key)).size !== lines.length
      || !lines.some(line => line.key === sourceKey)) {throw unresolved();}
  const selected = lines.filter(line => line.hidden);
  if (selected.length !== 1) {throw unresolved();}
  if (outbound) {assertVisibleAnchor(lines,row);}
  return /** @type {{id:number}} */ (selected[0]).id;
}

/**
 * Webhook-only rows can lack the accounting evidence retained by SuiteQL sync.
 * In that case read the source once and join by exact stable identity and item.
 * Quantities and cached source-sublist IDs are never rewritten.
 * @param {Record<string, any>[]} rows
 * @param {{sourceNetSuiteId: number, stage: string, fetchLiveSource?: Function | undefined}} context
 */
export async function storedTransferPostingRows(rows, {sourceNetSuiteId, stage, fetchLiveSource}) {
  const missing = rows.some(row => !Array.isArray(row.raw?.physicalRows));
  /** @type {Record<string,any>|undefined} */ let live;
  if (missing) {
    if (typeof fetchLiveSource !== 'function') {throw unresolved();}
    live = await fetchLiveSource({sourceOrderKind: 'TO', sourceNetSuiteId});
  }
  return rows.map(row => {
    let evidence = row;
    if (!Array.isArray(row.raw?.physicalRows)) {
      const matches = (live?.lines || []).filter((/** @type {Record<string, any>} */ line) => line.stage === stage
        && Number(line.itemId) === Number(row.item_id)
        && [line.sourceLineKey, ...(line.sourceLineAliases || [])].map(String).includes(String(row.source_line_key)));
      if (matches.length !== 1) {throw unresolved();}
      evidence = {...row, raw: matches[0].raw};
    }
    return {...row, netsuite_order_line: transferPostingOrderLine(evidence, {sourceNetSuiteId, stage})};
  });
}
