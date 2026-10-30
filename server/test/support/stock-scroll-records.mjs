// Synthetic long requests replace disposable, unavailable production captures.
const common = { id: 162, revision: 1, status: 'submitted', bucket: 'pending',
  storeLocationId: 1, storeName: '3445', destinationLocationId: 1, destinationName: '3445',
  requestedBy: 'viewer', requestedByName: 'TEST Viewer', createdAt: '2099-01-01T00:00:00Z',
  updatedAt: '2099-01-01T00:00:00Z', events: [], transfers: [], media: [], readinessAlerts: [], availability: [] };
const special = { ...common, requestType: 'special', workflowKind: 'special', workflowVersion: 2,
  requestRef: 'TEST-SCROLL-SPECIAL', stage: 'new_enquiry', closeStatus: 'active',
  inquiryDate: '2099-01-01', expiresOn: '2099-02-01', customerName: 'TEST scrolling customer',
  vendorId: 331, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
  salesOrderLines: [], purchaseOrderLines: [], lines: Array.from({ length: 24 }, (_, index) => ({
    id: index + 1, lineNumber: index + 1, productName: 'Synthetic material ' + (index + 1),
    quantity: 10, packageQuantity: 10, uom: 'PC', rateUom: 'PC', originalRate: 12,
    discountPercent: 0, pricingSource: 'enquiry', salesDecision: 'pending', supplyStatus: 'in_stock',
    requiredDate: '2099-02-01', vendorYard: 'TEST yard', customerNote: 'Synthetic saved request note' })) };
const regular = { ...common, requestType: 'regular', workflowVersion: 2,
  requestRef: 'TEST-SCROLL-REGULAR', displayStatus: 'pending',
  regular: { deliveryMethod: 'stocking', stockingType: 'transfer', requestingLocationId: 1,
    approval: { automatic: false, lines: [] } }, lines: Array.from({ length: 24 }, (_, index) => ({
    id: index + 1, itemId: 100 + index, itemName: 'Synthetic material ' + (index + 1),
    salesQty: 20, salesUom: 'EA', pieces: 20, toPcs: 1, toPlt: 100, status: 'submitted',
    sourceLocationId: 28, sourceName: '2967', destinationLocationId: 1, destinationName: '3445' })) };
const queue = record => Array.from({ length: 30 }, (_, index) => ({ ...structuredClone(record),
  id: record.id + index, requestRef: index ? record.requestRef + '-' + index : record.requestRef }));
export const stockScrollRecords = { special, specialSales: structuredClone(special),
  regular, regularSales: structuredClone(regular), specialQueue: queue(special), regularQueue: queue(regular) };
