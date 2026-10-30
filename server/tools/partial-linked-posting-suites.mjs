import fs from 'node:fs';
export const primary=['test/mbt/unit/partial-linked-posting.test.js',
  'test/mbt/integration/partial-linked-posting.test.js','test/mbt/concurrency/partial-linked-posting.test.js'];
export const regression=[...fs.readdirSync('test/mbt/unit').filter(name=>
  /^(operator-netsuite-posting-|operator-posting-rounding|direct-ship-posting|sales-delivery-load-fulfillment|receiving-followup-progress|receiving-posting-status)/.test(name)
  && name.endsWith('.test.js')).map(name=>`test/mbt/unit/${name}`),
  'test/mbt/property/operator-netsuite-posting.property.test.js',
  'test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js',
  'test/mbt/concurrency/operator-netsuite-posting-concurrency.test.js',
  ...['sales-delivery-load-fulfillment','operator-netsuite-posting-repository.red','operator-netsuite-posting-policy-repository.red',
    'operator-netsuite-posting-migration','operator-posting-rounding','operator-receiving-identity',
    'operator-receiving-allocations','operator-receiving-completed','receiving-followup','receiving-split-balance',
    'transfer-yard-posting','direct-po-materialized-split','direct-po-materialized-split-range']
    .map(name=>`test/mbt/integration/${name}.test.js`)];
