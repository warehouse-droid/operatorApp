import { specialItemDescription, specialPackPayload, SPECIAL_PACK_FIELDS } from '../public/special-stock-line-details.js';
import { createHash } from 'node:crypto';
import { query, withTransaction } from './db.js';
import { getSpecialStockCase } from './special-stock-request-repository.js';
import { normalizeSpecialCaseDraft, normalizeSpecialQuotePallet } from './special-stock-request-domain.js';
import { normalizeSpecialDeliveryFee, specialDeliveryFeeLine } from '../public/special-stock-delivery-fee.js';
import { quoteProfile } from './field-sales/company-quotes.js';
import { quotePdf } from './field-sales/pdf.js';
import { quoteDates } from '../public/field-sales/quote-drafts.js';
import { normalizeSpecialDiscount, normalizeSpecialRate, specialDiscountLineSubtotal as specialLineSubtotal, specialQuantity } from '../public/special-stock-pricing.js';

const invalid = (message, status = 400) => Object.assign(new Error(message), { status, code: 'SPECIAL_QUOTE_INVALID' });
const moneyMinor = value => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('The quote total is too large.');
  return Number(value);
};

function quotePackQuantities(line) {
  const native = specialPackPayload(line);
  return Object.fromEntries(Object.entries(SPECIAL_PACK_FIELDS).map(([field,key]) => [field,native[key] ?? null]));
}

/** @param {bigint} grossSubtotal @param {bigint} subtotal */
function quoteDiscountSummary(grossSubtotal, subtotal) {
  const discount = grossSubtotal - subtotal;
  return { grossSubtotalMinor: moneyMinor(grossSubtotal), discountMinor: moneyMinor(discount),
    discountPercent: grossSubtotal === 0n ? 0 : Number((discount * 10000n + grossSubtotal / 2n) / grossSubtotal) / 100 };
}

/** @param {Record<string,any>} detail @param {Array<Record<string,any>>} saved */
function quoteAncillaryLines(detail, saved) {
  const ancillary = saved.filter(line => line.ancillary);
  /** @param {Record<string,any>} line */
  const isPallet = line => Number(line.itemId) === 1784 || String(line.description || '').trim().toUpperCase() === 'PALLET';
  const palletLine = ancillary.find(isPallet);
  const input = detail.palletTotal == null && palletLine ? { palletTotal: palletLine.quantity, palletRate: palletLine.rate } : detail;
  const { palletTotal, palletRate } = normalizeSpecialQuotePallet(input);
  const deliveryRate = normalizeSpecialDeliveryFee(detail);
  const managedDelivery = deliveryRate != null || (Object.hasOwn(detail, 'deliveryFeeRate') && detail.fulfillmentMethod !== 'mbt_delivery');
  /** @type {Array<Record<string,any>>} */
  const lines = ancillary.filter(line => !isPallet(line) && (!managedDelivery || Number(line.itemId) !== 1987)).map(line => ({ ...line, discountPercent: 0 }));
  if (palletTotal > 0) lines.push({ ...palletLine, itemId: 1784, description: palletLine?.description || 'PALLET',
    quantity: palletTotal, uom: 'EACH', rate: palletRate, discountPercent: 0 });
  if (deliveryRate != null) lines.push({ ...specialDeliveryFeeLine(deliveryRate), uom: 'EACH', discountPercent: 0 });
  return lines;
}

// Reuse the Field Sales MBBS presentation and configuration without creating a
// Field Sales record, looking up a NetSuite item, or posting an estimate.
export function buildSpecialQuote(detail, company, { operatorName = '', draft = false } = {}) {
  if (detail.salesOrderId) throw invalid('The Sales Order has been created. Preview the Sales Order instead.', 409);
  const profile = quoteProfile(company);
  if (!profile.name || !Number.isInteger(profile.taxBps) || profile.taxBps < 0 || profile.taxBps > 10000) {
    throw invalid('Configure the MBBS company name and tax in Field Sales Settings.', 409);
  }
  const saved = detail.salesOrderLines || [];
  const materials = (detail.lines || []).filter(line => !['declined', 'closed'].includes(line.salesDecision));
  if (!materials.length) throw invalid('Add a priced item that has not been declined or closed to preview the quote.');
  const inputs = materials.map(line => {
    const orderLine = saved.find(order => order.caseLineId === line.id);
    const description = orderLine?.description || specialItemDescription(line);
    const legacy = !draft && line.originalRate == null;
    return { description: `MBBS-Special\n${description}`, quantity: legacy ? orderLine?.quantity : draft ? line.quantity : line.packageQuantity ?? line.quantity,
      uom: legacy ? orderLine?.uom : line.rateUom || line.uom,
      rate: legacy ? orderLine?.rate : draft ? line.rate : line.originalRate,
      discountPercent: legacy ? 0 : line.discountPercent,
      packQuantities: quotePackQuantities(legacy ? {...line,...orderLine} : line) };
  });
  inputs.push(...quoteAncillaryLines(detail, saved));
  const lines = inputs.map((line, index) => {
    const quantity = specialQuantity(line.quantity), unitRate = normalizeSpecialRate(line.rate);
    const discount = normalizeSpecialDiscount(line.discountPercent);
    const grossAmountMinor = Math.round(specialLineSubtotal(quantity, unitRate, 0) * 100);
    const amountMinor = Math.round(specialLineSubtotal(quantity, unitRate, discount) * 100);
    return { id: String(index + 1), company: 'MBBS', itemId: String(index + 1), sku: '',
      description: `${line.description}${grossAmountMinor > amountMinor ? `\nDiscount: ${discount}%` : ''}`,
      quantity: String(quantity), unit: line.uom, unitRate: String(unitRate),
      packQuantities: line.packQuantities || quotePackQuantities(line),
      grossAmountMinor, amountMinor };
  });
  const subtotal = lines.reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
  const grossSubtotal = lines.reduce((sum, line) => sum + BigInt(line.grossAmountMinor), 0n);
  const tax = (subtotal * BigInt(profile.taxBps) + 5000n) / 10000n;
  const totals = { ...quoteDiscountSummary(grossSubtotal, subtotal),
    subtotalMinor: moneyMinor(subtotal), taxMinor: moneyMinor(tax), totalMinor: moneyMinor(subtotal + tax), taxBps: profile.taxBps };
  const destination = detail.fulfillmentMethod === 'mbt_delivery' ? detail.deliveryAddress
    : detail.fulfillmentMethod === 'vendor_pickup' ? 'Customer pickup at vendor yard' : `Pickup at ${detail.storeName || 'inquired yard'}`;
  return { number: draft ? 'MBBS-QUOTE-DRAFT' : `Q-${detail.requestRef}`, selected_revision: draft ? 1 : detail.revision,
    snapshot: { schemaVersion: 2, simpleDetails: true, showPackQuantities: true, company: 'MBBS', currency: 'CAD',
      ...quoteDates(detail.inquiryDate, profile), ...(detail.expiresOn ? {validUntil: detail.expiresOn} : {}), customerName: detail.customerName, phone: detail.customerPhone || '',
      salesRep: detail.netsuiteSalesRepName || (draft ? operatorName : detail.requestedByName || ''), shippingMethod: detail.fulfillmentMethod === 'mbt_delivery' ? 'Delivery' : 'Pick-Up',
      jobsite: { address: destination }, note: [draft ? 'Draft quote' : '', detail.remarks].filter(Boolean).join('\n'),
      companyProfiles: { MBBS: profile }, lines, companies: { MBBS: totals }, ...totals } };
}

export function createSpecialQuoteService({ getCase = getSpecialStockCase, renderPdf = quotePdf,
  getProfile = async () => (await query('SELECT data FROM field_sales_settings WHERE singleton')).rows[0]?.data?.companies?.MBBS } = {}) {
  const document = async (detail, options) => {
    const quote = buildSpecialQuote(detail, await getProfile(), options);
    return { buffer: await renderPdf(quote), filename: `${quote.number}-r${quote.selected_revision}.pdf` };
  };
  return {
    previewDraft: (input, context) => document(normalizeSpecialCaseDraft(input, context), { ...context, draft: true }),
    savedQuote: async (id, context = {}) => document(await getCase(id, { audience: 'sales', authorizedStoreLocationIds: context.authorizedStoreLocationIds }), { draft: false })
  };
}

export function specialOrderSnapshot(detail, kind, audience) {
  if (!['sales_order', 'purchase_order'].includes(kind) || !['sales', 'scm'].includes(audience)) throw invalid('Choose a valid order preview.');
  if (kind === 'purchase_order' && audience !== 'scm') throw invalid('Purchase Order PDFs are available to SCM only.', 403);
  const sales = kind === 'sales_order';
  const id = sales ? detail.salesOrderId : detail.purchaseOrderId;
  const lines = sales ? detail.salesOrderLines : detail.purchaseOrderLines;
  if (!id || (sales ? detail.salesOrderSkipped : detail.purchaseOrderSkipped) || !lines?.length) throw invalid('This request has no linked order to preview.', 409);
  return { version: 2, source: 'netsuite-native', kind, audience, id, title: sales ? 'Sales Order' : 'Purchase Order',
    number: sales ? detail.salesOrderRef : detail.purchaseOrderRef, requestRef: detail.requestRef,
    status: (sales ? detail.salesOrderStatus : detail.purchaseOrderStatus) || 'Awaiting status update',
    customerName: detail.customerName, vendorName: detail.vendorName,
    relatedOrder: sales ? detail.purchaseOrderRef : detail.salesOrderRef,
    yard: ({ 1: '3445', 28: '2967', 15: '12441', 26: '150' })[detail.operationalYardLocationId] || detail.storeName,
    deliveryAddress: detail.deliveryAddress || '', quantityReviewPending: Boolean(detail.quantityReviewPending),
    ...(detail.quantityReview?.id ? {orderAdjustment:{id:detail.quantityReview.id,status:detail.quantityReview.status}} : {}),
    attentionReason: detail.attention ? detail.attentionReason : '',
    lines: lines.map(line => ({ itemId: line.itemId, itemName: line.itemName, description: line.description,
      ...(line.nativeDiscountPercent == null ? {} : {discountPercent:line.nativeDiscountPercent}),
      quantity: specialQuantity(line.quantity), uom: line.uom,
      rate: (sales ? line.rate : line.unitPurchaseCost) == null ? null
        : normalizeSpecialRate(sales ? line.rate : line.unitPurchaseCost) })) };
}

async function fetchNativeOrderPdf(kind, id) {
  const netsuite = await import('./netsuite.js');
  try {
    return await (kind === 'sales_order' ? netsuite.fetchSalesOrderPdfFromNetSuite : netsuite.fetchPurchaseOrderPdfFromNetSuite)(id);
  } catch (cause) {
    const message = /MBBS_UNSUPPORTED_ACTION/.test(cause.message)
      ? 'NetSuite needs the updated order PDF script before this preview is available.'
      : 'NetSuite could not provide the order PDF. Please try again.';
    throw Object.assign(invalid(message, 502), { cause });
  }
}

export function createSpecialOrderDocumentService({ getCase = getSpecialStockCase, fetchPdf = fetchNativeOrderPdf } = {}) {
  return { async preview(id, kind, { audience, authorizedStoreLocationIds } = {}) {
    const context = { audience, authorizedStoreLocationIds, dispatchPlans: [] };
    specialOrderSnapshot(await getCase(id, context), kind, audience);
    return withTransaction(async () => {
      // Serialize cache misses without holding the case row during NetSuite I/O.
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`special-order-pdf:${id}:${kind}:${audience}`]);
      const snapshotHash = async () => createHash('sha256').update(JSON.stringify(
        specialOrderSnapshot(await getCase(id, context), kind, audience))).digest('hex');
      const detail = await getCase(id, context);
      const snapshot = specialOrderSnapshot(detail, kind, audience);
      const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const cached = (await query(`SELECT pdf,filename,generated_at FROM sales_special_stock_document_cache
        WHERE request_id=$1 AND order_kind=$2 AND audience=$3 AND snapshot_hash=$4`, [id, kind, audience, hash])).rows[0];
      if (cached) return { buffer: cached.pdf, filename: cached.filename, cached: true, generatedAt: cached.generated_at };
      const { buffer, filename: nativeFilename } = await fetchPdf(kind, snapshot.id);
      if (!Buffer.isBuffer(buffer) || buffer.length > 15728640 || buffer.subarray(0, 5).toString() !== '%PDF-') throw invalid('NetSuite returned an invalid order PDF.', 502);
      await query('SELECT request_id FROM sales_special_stock_cases WHERE request_id=$1 FOR UPDATE', [id]);
      if (await snapshotHash() !== hash) throw invalid('The order changed while the PDF was loading. Please preview it again.', 409);
      const filename = String(nativeFilename || `${snapshot.number}-${detail.requestRef}.pdf`).replace(/[^a-zA-Z0-9_.-]/g, '-');
      const saved = await query(`INSERT INTO sales_special_stock_document_cache(request_id,order_kind,audience,snapshot_hash,filename,pdf)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_id,order_kind,audience) DO UPDATE
        SET snapshot_hash=EXCLUDED.snapshot_hash,filename=EXCLUDED.filename,pdf=EXCLUDED.pdf,generated_at=now() RETURNING generated_at`,
      [id, kind, audience, hash, filename, buffer]);
      return { buffer, filename, cached: false, generatedAt: saved.rows[0].generated_at };
    });
  } };
}
