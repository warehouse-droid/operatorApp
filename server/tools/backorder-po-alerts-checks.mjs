import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const files=[
  'test/mbt/integration/backorder-po-progress.test.js',
  'test/mbt/integration/backorder-po-progress-browser.test.js',
  'test/mbt/integration/already-ordered-arrival.test.js',
  'test/mbt/integration/already-ordered-arrival-browser.test.js',
  'test/mbt/integration/backorder-already-ordered.test.js',
  'test/mbt/integration/backorder-already-ordered-browser.test.js',
  'test/mbt/integration/backorder-review-flow-browser.test.js',
];
process.exitCode=await runNodeTestFilesIsolated(process.argv.length>2?process.argv.slice(2):files,{label:'Backorder PO alerts',
  environment:{...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS,'--require=/app/tools/bin-order-workflow-browser-env.cjs'].filter(Boolean).join(' ')}});
