# TO conflict cleanup using authoritative NetSuite data

The user explicitly authorized resolving the previously skipped TO line/quantity conflicts by respecting NetSuite. This follow-up covers the 26 TOs held for `receiving_sync_exception` or `unsafe_packed_line` in the applied TO cleanup manifest. It retains the separately skipped cancelled source families and ambiguous order reference.

Spec approval: not obtained (autonomous run); live application is authorized by the user's follow-up and prior dry-run / isolated-test / apply instructions. Use the old-coder Tier 3 workflow, scaled to a one-time data correction. No dependency installation or Git mutation is planned.

## Acceptance scenarios

1. Fetch current exact TO IDs, status and complete source/destination lines from NetSuite using SELECT only. Match the TO reference and unique line identities. A current G/Received TO with a local stale/deleted Receiving line is repaired from the current NetSuite lines, then marked Loaded and Received.
2. For TOB00956, choose NetSuite's current quantity for Alliance Supersand Grey, resolving the local 840 / 1,120 conflict. Do not infer its quantity from a header-only status or from the stale line.
3. Collapse NetSuite's source/accounting/destination mirror rows through the existing canonical normalization, preserving repeated logical items. Correct stage-specific lines, reactivate exact current lines, retire missing ones and clear resolved sync exceptions and unposted selections. Preserve historical rows and physical receipt/Driver evidence.
4. G/Received authorizes Received; F/Pending Receipt authorizes only Loaded. Missing, partial, closed, ambiguous or invalid NetSuite proof cannot authorize this correction. Keep active Operator work, claims, cancelled/held families and local identity ambiguities protected.
5. Preserve the existing direct local-completion policy and cached NetSuite lifecycle fields for locally completed orders; NetSuite-only completion remains planable. Driver/manual/direct completion stays blocked from replanning. Use current NetSuite line quantities for both paths.
6. Use an explicit manifest with before-images, after-images, current evidence and a checksum. Rehearse it in an isolated test database; test rollback, exact apply, repeat with zero changes, stale data rejection and stage isolation.
7. Apply atomically under Fleet/Operator/table locks. Assert that unrelated TOs, SOs/POs, Driver jobs/photos, receipts, posting queues, dependencies, COs, plans, schedules and reconciliation state are unchanged. Do not post receipts or fulfillments to NetSuite.
8. Verify actual Operator Delivery/Receiving projections and Dispatch planning restrictions after application, including TOB00956 and today's work.

## Failure model and validation

- Wrong or incomplete source proof: strict ID/reference/status/line identity and quantity assertions, adversarial tests and properties.
- Wrong-stage updates or duplicated mirror quantities: explicit `(line_stage,id)` keys and canonical source/destination assertions.
- Lost local work, partial writes or races: before-image revalidation, claims and locks, transactional rollback, protected-state assertions and stale-manifest tests.
- A test that merely follows implementation: concrete failing conflict fixtures, property-only mutation checks and comparison against captured NetSuite facts.
- Incorrect live result: exact captured-data rehearsal, repeat verification and read-only PWA checks. Existing production runtime is preserved; this is a maintenance-tool/data change.

Persist source hashes, test commands/results, backups and any unverified layers in the evidence report. Existing dependencies and the isolated Docker test harness are reused.

## Scope clarification — authoritative conflict follow-up

The user's latest instruction to respect NetSuite for conflicted TOs supersedes acceptance scenario 5's cached-status preservation for these 26 records. Refresh their cached `status` and `status_text` from the current NetSuite proof, including locally delivered TOs. Preserve actual fulfillment/receipt IDs and timestamps, Driver history and the local-completion replanning block. The earlier general cleanup policy remains unchanged outside this explicitly selected conflict set.
