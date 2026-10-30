// Run in a separate process in the existing app container with the routing gate
// overridden to false. A null input cannot form a NetSuite posting request.
import assert from 'node:assert/strict';
import { config } from './src/config.js';
import { postIfirViaNetSuiteRestlet } from './src/netsuite.js';
import { closeDb } from './src/db.js';
try {
  assert.equal(config.netsuite.ifirPostingEnabled, false);
  assert.equal(await postIfirViaNetSuiteRestlet(null), null);
  console.log(JSON.stringify({ enabled: false, nativeRoutingSentinel: true,
    runningApplicationConfigurationChanged: false, postingRequest: false }));
} finally { await closeDb(); }
