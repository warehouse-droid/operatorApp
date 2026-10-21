import {existing as itemExisting,own as itemOwn} from './special-sales-items-copy-suites.mjs';
export const existing=[...new Set([...itemExisting,...itemOwn,
 'test/mbt/unit/special-workflow-documents.test.js',
 'test/mbt/unit/special-workflow-native-documents.test.js',
 'test/mbt/unit/special-quote-discount-summary.test.js',
 'test/mbt/unit/special-quote-breakdown.test.js',
 'test/mbt/unit/special-quote-requester.test.js',
 'test/mbt/integration/special-workflow-pricing-http.test.js'])];
export const own=['test/mbt/unit/special-quote-pallet.test.js',
 'test/mbt/integration/special-quote-pallet-http.test.js',
 'test/mbt/integration/special-quote-pallet-browser.test.js'];
