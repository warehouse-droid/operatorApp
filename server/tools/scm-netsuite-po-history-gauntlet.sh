#!/usr/bin/env bash
set -euo pipefail

npm run test:scm-netsuite-po-unit-conversion
npm run test:scm-netsuite-po-history-filters
npm run test:scm-netsuite-po-history
npm run test:smart-scm-purchase-review
npm run coverage:scm-netsuite-po-unit-conversion
npm run mutate:scm-netsuite-po-history

node --check src/scm-netsuite-po-unit-conversion.js
node --check src/scm-netsuite-po-history-repository.js
node --check src/scm-netsuite-po-history-service.js
node --check src/smart-scm-purchase-netsuite.js
node --check src/server.js
node --check public/scm-netsuite-po.js

echo "NetSuite PO history gauntlet passed."
