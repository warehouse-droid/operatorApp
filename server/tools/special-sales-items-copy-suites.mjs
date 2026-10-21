import {existing as noteExisting,own as noteOwn} from './special-po-so-note-suites.mjs';
export const existing = [...noteExisting,...noteOwn,
  'test/mbt/unit/special-stock-request-domain.red.test.js',
  'test/mbt/unit/special-stock-request-policy.red.test.js',
  'test/mbt/unit/special-workflow-enquiry.test.js',
  'test/mbt/unit/special-request-enhancements.test.js',
  'test/mbt/unit/special-quote-packing.test.js',
  'test/mbt/integration/special-workflow-enquiry.test.js',
  'test/mbt/integration/special-stock-request-http.red.test.js',
  'test/mbt/integration/special-enhancements-http.test.js',
  'test/mbt/integration/special-enhancements-browser.test.js',
  'test/mbt/property/special-stock-request-domain.property.test.js'];
export const own = ['test/mbt/unit/special-sales-items-copy.test.js',
  'test/mbt/integration/special-sales-items-copy-http.test.js',
  'test/mbt/integration/special-sales-items-copy-browser.test.js'];
