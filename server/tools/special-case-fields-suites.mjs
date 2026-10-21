import { existing as earlier, own as caseEdits } from './special-case-edits-suites.mjs';
export const own = ['test/mbt/unit/special-case-fields.test.js','test/mbt/unit/special-case-fields-orders.test.js',
  'test/mbt/integration/special-case-fields-http.test.js','test/mbt/integration/special-case-fields-browser.test.js'];
export const existing = [...new Set([...earlier,...caseEdits,
  'test/mbt/unit/special-line-decline.test.js','test/mbt/integration/special-line-decline-browser.test.js',
  'test/mbt/integration/special-line-decline-http.test.js','test/mbt/unit/special-sales-request-corrections.test.js',
  'test/mbt/integration/special-sales-request-corrections-http.test.js','test/mbt/integration/special-sales-request-corrections-browser.test.js',
  'test/mbt/unit/special-scm-item-name.test.js','test/mbt/integration/special-scm-item-name.test.js',
  'test/mbt/unit/special-stock-updates.test.js','test/mbt/integration/special-stock-updates-http.test.js',
  'test/mbt/integration/special-stock-updates-browser.test.js','test/mbt/unit/special-workflow-quantity-service.test.js',
  'test/mbt/unit/special-workflow-adjustment-adapter.test.js','test/mbt/unit/special-workflow-rest-orders.test.js',
  'test/mbt/unit/special-workflow-quantity-transition.test.js','test/mbt/unit/special-workflow-quantity-adapter.test.js','test/mbt/integration/special-workflow-pricing.test.js'
])];
