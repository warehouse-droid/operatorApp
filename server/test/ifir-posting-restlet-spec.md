# IR/IF response RESTlet executable specification

Tier 3: inventory/accounting writes and retry ambiguity. Spec approval: not
obtained (autonomous run); user authorized the script and explicitly requires
the old flow until deployment. This package adds no active application wiring,
environment setting, dependency, database change, or deployment.

Acceptance scenarios (named tests are the executable specification):

1. PO -> IR, SO -> IF, TO -> IF, TO -> IR transform only the selected source
   lines, preserve quantities/locations and pack columns, memo and custbody9,
   save once, then reload the saved record. The JSON response includes contract
   version, actual record ID, actual tranId, externalId, createdFromId,
   transactionType, header status/date/memo, saved line identities/items,
   quantities, units, locations, pack columns and inventory assignments.
2. Returned values come from the saved record, never from the submitted payload;
   the existing application verifier accepts a matching result and rejects
   changed saved source, type, external ID, item, location or quantity.
3. PO receipts include source-order evidence and item classification/rate/amount
   for native auto-included purchase charges; the existing charge verifier
   validates them without another external read. Missing values are not invented.
4. Repeated external IDs return the original saved record without another save.
   A different source or record type is a conflict. A race losing the native
   external-ID uniqueness check recovers the winner; uncertain save/read failures
   remain explicitly ambiguous and never cause an automatic second transform.
5. Malformed IDs, nonfinite/nonpositive quantities, duplicate/missing order
   lines, unsupported fields, record types or inventory requirements are
   rejected before save. Unselected/unrequested material must not be posted.
   There is no ignoreMandatoryFields override or write endpoint accepting
   arbitrary NetSuite record types.
6. Empty/missing assigned document numbers after save yield a known internal ID
   with an incomplete response, not fabricated success. Every incomplete saved
   result requires reconciliation, never a new external ID or blind repost.
7. Health is read-only. Writes require a deployment checkbox parameter; a
   second checkbox permits production use. Caller input cannot enable either.
8. Existing application source hashes stay unchanged. No live NetSuite calls,
   production posting, container restart or production configuration changes.

Failure model: accidental full-order posting (selection/adversarial tests),
wrong line identity (duplicate/reordered source tests), save succeeds but response
is lost (retry and read-failure tests), concurrent duplicate (native uniqueness
boundary simulation), misleading number/quantity (reload and existing-verifier
contract tests), amount/unit mismatch (charge verifier tests), unsupported
kit/bin/lot configuration (fail closed), activation before deployment (source
hashes and deployment parameter tests). Real NetSuite account workflows,
mandatory fields, kit behavior and database uniqueness require sandbox proof;
boundary simulations do not prove NetSuite execution.

Setup: use the existing Node test runner, fast-check, TypeScript and ESLint;
no dependency installation or commits. Add one SuiteScript 2.1 RESTlet, a
deployment guide in the existing repository documentation, a boundary fixture,
tests and a reproducible gauntlet. Tests use the standard isolated Compose
configuration, mbbs-tests.slice and existing resource limits, with teardown
registered before creation, run --rm, down --volumes --remove-orphans and both
docker ps / docker ps -a checked on exit. Retain logs, not databases. Run scoped
regressions, types/lint, coverage, properties and manual mutants. Report layers
that cannot run and the outstanding NetSuite sandbox validation honestly.
