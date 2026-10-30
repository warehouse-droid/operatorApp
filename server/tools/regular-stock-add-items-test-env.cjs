// Preserve the legacy Special Order suite's database-host guard while running
// against the standard disposable Compose database and its per-file clone.
require('./stock-request-followups-browser-env.cjs');
if (process.argv[1]?.endsWith('/special-sales-items-copy-http.test.js')) {
  const assert = require('node:assert/strict'), dns = require('node:dns');
  const database = new URL(process.env.DATABASE_URL);
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.ok(['db', 'mbbs-special-review-db'].includes(database.hostname));
  assert.match(database.pathname, /^\/mbt_test_file_[a-f0-9]{12}_[a-z0-9]+$/);
  const lookup = dns.lookup;
  dns.lookup = (hostname, ...args) => lookup(hostname === 'mbbs-special-review-db' ? 'db' : hostname, ...args);
  database.hostname = 'mbbs-special-review-db';
  process.env.DATABASE_URL = database.href;
}
