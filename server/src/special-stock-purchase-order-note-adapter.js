/**
 * @typedef {{purchaseOrderId:number,purchaseOrderRef:string,vendorId:number}} Identity
 * @typedef {Identity & {note:string,expectedNote:string}} Edit
 * @typedef {{rest:(path:string,options:{method:string,body?:Record<string,unknown>})=>Promise<{data?:Record<string,any>}>}} Boundary
 */
/** @param {string} message @param {number} [status] */
const conflict = (message,status=409) => Object.assign(Error(message),{status,code:'SPECIAL_PO_NOTE_CONFLICT'});
/** @param {Identity} input */
function pathFor(input) {
  if (!Number.isSafeInteger(Number(input.purchaseOrderId)) || Number(input.purchaseOrderId)<=0
      || !input.purchaseOrderRef || !Number.isSafeInteger(Number(input.vendorId)) || Number(input.vendorId)<=0) {
    throw conflict('The linked real NetSuite PO is required.');
  }
  return `/record/v1/purchaseOrder/${Number(input.purchaseOrderId)}`;
}
/** @param {Identity} input @param {Boundary} boundary */
export async function readSpecialPurchaseOrderNote(input,boundary) {
  const record=(await boundary.rest(pathFor(input),{method:'GET'})).data;
  if (Number(record?.id)!==Number(input.purchaseOrderId) || record?.tranId!==input.purchaseOrderRef
      || Number(record?.entity?.id)!==Number(input.vendorId)) throw conflict('The NetSuite PO does not match this request.');
  return String(record.custbody7 ?? '');
}
/** @param {Edit} input @param {Boundary} boundary */
export async function updateSpecialPurchaseOrderNote(input,boundary) {
  const path=pathFor(input);
  if (typeof input.note!=='string' || input.note.length>4000 || typeof input.expectedNote!=='string') {
    throw conflict('Enter a PO Note of at most 4000 characters and reload its current value.',400);
  }
  const current=await readSpecialPurchaseOrderNote(input,boundary);
  // Recover a committed write even when its response or local commit was lost.
  if (current===input.note) return current;
  if (current!==input.expectedNote) throw conflict('The NetSuite PO Note changed. Reload this request before saving.');
  let writeError;
  try {
    await boundary.rest(path,{method:'PATCH',body:{custbody7:input.note}});
  } catch (error) { writeError=error; }
  const verified=await readSpecialPurchaseOrderNote(input,boundary);
  if (verified!==input.note) throw writeError || conflict('NetSuite has not verified the PO Note. Reload and retry.',502);
  return verified;
}
