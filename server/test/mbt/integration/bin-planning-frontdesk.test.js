import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, closeDb } from "../../../src/db.js";
import { createFrontdeskQuote, issueFrontdeskQuote, acceptFrontdeskQuote, convertFrontdeskQuote,
  extendFrontdeskServiceLine, exchangeFrontdeskServiceLine } from "../../../src/mbt/frontdesk-service.js";
import { createFrontdeskPrerequisites, frontdeskCommand, quoteCommand, frontdeskDistanceResolver,
  frontdeskTaxResolver } from "../support/frontdesk-fixtures.js";
after(closeDb);
const actor = { operatorId: "planner-frontdesk-check", roles: ["mbt_frontdesk"] };

test("a ready unassigned return can be extended or exchanged without changing commercial pricing", async () => {
  const f = await createFrontdeskPrerequisites({ label: "planner-return" });
  const created = await createFrontdeskQuote({ ...quoteCommand(f, { actor, identity: crypto.randomUUID() }),
    serviceLines: [{ binTypeId: f.binTypeId, proposedDeliveryAt: "2037-08-03T12:00:00Z", proposedReturnAt: "2037-08-17T12:00:00Z" }] },
  { resolveDistance: frontdeskDistanceResolver(f), resolveTaxPolicy: frontdeskTaxResolver });
  const quoteId = created.body.quote.quoteId;
  await issueFrontdeskQuote(frontdeskCommand("planning-issue", actor, { quoteId, expectedRevision: 1, validUntil: "2037-08-04T12:00:00Z" }));
  await acceptFrontdeskQuote(frontdeskCommand("planning-accept", actor, { quoteId, expectedRevision: 2, acceptedAt: "2037-08-03T10:00:00Z" }));
  const result = await convertFrontdeskQuote(frontdeskCommand("planning-convert", actor, { quoteId, expectedRevision: 3 }));
  const contractId = result.body.contract.contractId; const line = result.body.serviceLines[0];
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=now() WHERE service_line_id=$1 AND service_action='delivery'", [line.serviceLineId]);
  await query("UPDATE mbt_service_visits SET status='ready' WHERE service_line_id=$1 AND service_action='return_bin'", [line.serviceLineId]);
  const pricing = (await query("SELECT pricing_snapshot FROM mbt_contracts WHERE contract_id=$1", [contractId])).rows[0];
  const currentLine = (await query("SELECT revision::int FROM mbt_contract_service_lines WHERE service_line_id=$1", [line.serviceLineId])).rows[0];
  const extended = await extendFrontdeskServiceLine(frontdeskCommand("planning-extend", actor, {
    contractId, serviceLineId: line.serviceLineId, expectedRevision: currentLine.revision,
    returnWindow: { startAt: "2037-08-24T12:00:00Z", endAt: "2037-08-24T16:00:00Z" } }));
  assert.equal(extended.body.returnVisit.status, "ready");
  assert.deepEqual((await query("SELECT pricing_snapshot FROM mbt_contracts WHERE contract_id=$1", [contractId])).rows[0], pricing);
  const exchanged = await exchangeFrontdeskServiceLine(frontdeskCommand("planning-exchange", actor, {
    contractId, serviceLineId: line.serviceLineId, expectedRevision: extended.body.serviceLine.revision,
    exchangeWindow: { startAt: "2037-08-04T12:00:00Z", endAt: "2037-08-04T16:00:00Z" },
    incomingBinTypeId: f.binTypeId, chargeMode: "free_internal", waiverReason: "Test replacement" }));
  assert.equal(exchanged.body.returnVisit.status, "tentative");
  assert.equal(exchanged.body.returnVisit.predecessorVisitId, exchanged.body.exchangeVisit.visitId);
});
