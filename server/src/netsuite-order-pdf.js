import { Buffer } from 'node:buffer';
const actions = { sales_order: 'salesOrderPdf', purchase_order: 'purchaseOrderPdf' };
/** @param {string} message */
const invalid = message => Object.assign(new Error(message), { status: 502 });

/** Retrieve original NetSuite transaction bytes; never rebuild or redact them.
 * @param {'sales_order'|'purchase_order'} kind
 * @param {unknown} orderId
 * @param {{restlet: (request: {action:string,entityId:number,includeContent:boolean}) => Promise<any>, filenamePrefix?:string}} dependencies
 */
export async function fetchNetSuiteOrderPdf(kind, orderId, { restlet, filenamePrefix } ) {
  if (!Object.hasOwn(actions, kind)) throw invalid('Choose a valid NetSuite order kind.');
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) throw invalid('A valid numeric NetSuite order ID is required.');
  const payload = await restlet({ action: actions[kind], entityId: id, includeContent: true });
  if (payload?.ok !== true || payload.action !== actions[kind] || Number(payload.entityId) !== id) {
    throw invalid('NetSuite order PDF returned the wrong transaction identity.');
  }
  const content = payload.contentBase64;
  if (payload.contentType !== 'application/pdf' || payload.contentEncoding !== 'base64'
    || typeof content !== 'string' || !content || content.length > 20971520
    || content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(content)) {
    throw invalid('NetSuite order PDF returned invalid or oversized PDF content.');
  }
  const buffer = Buffer.from(content, 'base64');
  if (buffer.length > 15728640 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-' || buffer.toString('base64') !== content) {
    throw invalid('NetSuite order PDF returned invalid PDF content.');
  }
  const prefix = filenamePrefix || (kind === 'sales_order' ? 'SO' : 'PO');
  return { buffer, contentType: 'application/pdf',
    filename: String(payload.filename || `${prefix}-${id}.pdf`).replace(/[^a-zA-Z0-9_.-]+/g, '-') };
}
