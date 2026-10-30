/**
 * @NApiVersion 2.1
 */
define([], () => ({
  account: '6518947',
  item: '1784',
  physicalSearch: 'customsearch503',
  balanceSearch: 'customsearch_pallet_payment_balance',
  writerScript: 'customscript_ppa_rebuild',
  writerDeployment: 'customdeploy_ppa_rebuild',
  queueType: 'customrecord_pallet_refresh_queue',
  queueBatchSize: 50,
  queueRetryMinutes: 15,
  queueFields: {
    customer: 'custrecord_ppq_customer', retry: 'custrecord_ppq_retry_minute', error: 'custrecord_ppq_error'
  },
  allocationType: 'customrecord_pallet_payment_alloc',
  refundType: 'customrecord_pallet_refund_alloc',
  allocationFields: {
    customer: 'custrecord_ppa_customer', so: 'custrecord_ppa_so', invoice: 'custrecord_ppa_invoice',
    line: 'custrecord_ppa_line', sources: 'custrecord_ppa_payments', method: 'custrecord_ppa_method',
    last4: 'custrecord_ppa_last4', currency: 'custrecord_ppa_currency', rate: 'custrecord_ppa_rate',
    qty: 'custrecord_ppa_alloc_qty', pending: 'custrecord_ppa_pending_qty',
    refunded: 'custrecord_ppa_refunded_qty', verified: 'custrecord_ppa_verified'
  },
  refundFields: {
    allocationId: 'custrecord_pra_allocation', refund: 'custrecord_pra_refund', credit: 'custrecord_pra_creditmemo',
    returnRef: 'custrecord_pra_return_ref', qty: 'custrecord_pra_qty', amount: 'custrecord_pra_amount', status: 'custrecord_pra_status'
  },
  // Optional, evidence-backed historical card references. Never infer a value here.
  // Example: '12345': { method: '5', last4: '0070', evidence: 'Receipt reviewed by ... on ...' }
  // Keys are ORIGINAL payment / customer deposit / refund internal IDs, not SO numbers.
  cardOverrides: {},
  maxRows: 6000,
  maxRecordsToLoad: 180
}));
