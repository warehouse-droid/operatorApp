import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(serverRoot, relativePath), "utf8");

const migration = read("migrations/087_smart_scm_live_execution.sql");
const server = read("src/server.js");
const netSuite = read("src/netsuite.js");
const repository = read("src/smart-scm-vendor-repository.js");
const poUi = read("public/scm-netsuite-po.js");
const proposalUi = read("public/scm-smart-proposals.js");
const smartUi = read("public/scm-smart.js");

assert.match(migration, /ALTER COLUMN execution_mode SET DEFAULT 'live'/);
assert.match(migration, /SET execution_mode = 'live'/);

assert.match(netSuite, /findTransferOrdersBySmartScmMarkerFromNetSuite/);
assert.match(server, /recoverSmartScmTransferOrder/);
assert.match(server, /markerMatch = await recoverSmartScmTransferOrder/);
assert.match(server, /fetchPickingTicketFromNetSuite\(transferOrderId,\s*\{\s*locationId:/);

assert.match(
  server,
  /app\.delete\("\/api\/scm\/smart\/netsuite-purchase-orders\/:id", requireSmartScmWriteAccess/,
  "Staged-PO removal must retain Smart SCM write authorization."
);
assert.match(repository, /SET status = 'cancelled'/);
assert.match(repository, /po_execution_status = 'removed'/);
assert.match(repository, /canRemoveFromStaging:/);
assert.match(poUi, /data-po-action="remove"/);
assert.match(poUi, /method: "DELETE"/);
assert.match(poUi, /value="removed"/);

assert.match(proposalUi, /"Confirm TO \+ print"/);
assert.match(proposalUi, /"Retry TO \+ print"/);
assert.match(smartUi, /Live — guarded NetSuite PO \+ TO/);
assert.doesNotMatch(proposalUi, /TO \/ mock ref/);

console.log(JSON.stringify({
  ok: true,
  liveGate: true,
  toMarkerRecovery: true,
  netSuitePickingTicket: true,
  stagedPoRemoval: true
}));
