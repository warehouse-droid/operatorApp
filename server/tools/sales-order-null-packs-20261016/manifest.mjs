export const sources = [
  'public/order-pack-quantities.js', 'public/special-stock-line-details.js', 'public/special-stock-line-fields.js',
  'src/special-stock-request-domain.js', 'src/special-stock-request-netsuite.js', 'src/netsuite.js',
  'src/special-stock-adjustment-adapter.js', 'src/special-stock-rest-orders.js',
  'netsuite-field-sales-restlet.js', 'netsuite-smart-scm-picking-ticket-restlet.js'
];
export const tests = [
  'test/mbt/unit/sales-order-null-packs.test.js', 'test/mbt/integration/sales-order-null-packs.test.js',
  'test/mbt/integration/sales-order-null-packs.browser.test.js',
  ...['special-request-enhancements.test.js', 'special-quote-packing.test.js', 'special-case-fields.test.js', 'special-case-fields-orders.test.js',
    'special-workflow-adjustment-restlet.test.js', 'special-workflow-rest-orders.test.js', 'special-stock-request-domain.red.test.js',
    'special-stock-request-netsuite.red.test.js', 'special-stock-request-service.red.test.js', 'special-so-unitless-verification.test.js',
    'special-so-creation-confirmation.test.js', 'special-workflow-pricing.test.js', 'special-workflow-quantity-service.test.js',
    'special-sales-items-copy.test.js', 'special-quote-pallet.test.js'].map(name => 'test/mbt/unit/' + name),
  'test/mbt/property/special-stock-request-domain.property.test.js',
  'test/mbt/integration/special-request-enhancements.test.js',
  'test/field-sales/order-restlet.test.js', 'test/field-sales/existing-customer-restlet.test.js'
];
