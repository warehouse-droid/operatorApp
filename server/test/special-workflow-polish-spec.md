# Special workflow forms and test skips — 2026-09-24

The user requests these changes to the deployed Special Item workflow. Proceed
autonomously under that instruction and the existing deployment authorization.
Spec approval: not obtained (autonomous run); this document records the user's
requirements and the implementation assumptions for review afterward.

Use the existing old-coder Tier 3 checks because gated test skips affect order
progression and authorization. No new packages, dependency changes or commits.
Preserve the dirty workspace and the previous release evidence. Store the task
baseline separately and release only this task's changes onto each current image.
Use the existing isolated PostgreSQL/browser environment for regression tests.

## Acceptance scenarios

1. Delivery enquiries require the delivery address, but neither contact name nor
   contact phone is shown or required. Existing stored contact data remains
   compatible. SO preparation also works without those optional contact fields.
   This supersedes the earlier test requiring a delivery contact phone.
2. SCM stock check shows supply status, vendor autocomplete, pickup location and
   notes. NetSuite vendor ID is kept internally; vendor reference and purchase
   cost are absent from stock check. Purchase cost remains in the PO review.
   Editing vendor text clears the selected ID; selecting a result binds its ID.
3. SCM stock-check ETA is visible and required only for the line status
   `production` (label “Wait For Production”). In-stock and no-stock responses
   carry no ETA. A later readiness check shows ETA only while stock is not ready.
4. Special workflow forms have at most three visible input controls per grid
   row on desktop, two on smaller screens and one on mobile. Address, descriptions
   and longer notes have appropriate full-width rows. Regular forms retain their
   existing layout. No horizontal overflow at 390px.
5. Saving a line retains the detail panel's scroll position (or the same line's
   position when feedback changes height). Desktop panel and mobile page scrolling
   are covered. Other unsaved lines retain their edits.
6. SO preparation has one visible autocomplete field labeled “NetSuite Customer”.
   It selects an active synced customer; no editable numeric customer-ID field.
   Typing after selection clears the bound ID. Late search responses cannot change
   the current request, query or selected customer, and search does not steal focus.
7. Validation, network and revision-conflict errors retain all entered values in
   new-request, SCM and SO/PO forms. A conflict refreshes the current revision
   without replacing local form drafts. Success clears only the submitted draft.
8. A new Admin feature gate `special_stock_request_test_skip_orders`, default off,
   controls both “Skip SO creation” and “Skip PO Creation”. When off, buttons are
   absent and direct skip APIs reject requests. Existing role/yard checks apply.
9. With the gate on, Sales can skip SO after saving a valid SO draft; SCM can skip
   PO after reviewing purchase details and having a completed/approved SO step.
   Each skip is atomic, revision checked and audited. Duplicate/stale/concurrent
   submissions cannot duplicate an event or overwrite a real order/in-flight
   operation. No real remote order ID is invented and no NetSuite call is made.
10. Skipped steps advance stages exactly like completed order steps, retaining
    production-waiting priority. Persisted test markers survive gate disable/reload.
    Requests show an explicit test notice. Simulated orders do not enter live
    Dispatch handoffs or NetSuite posting/link/refresh paths. Local vendor pickup
    completion can still be tested with normal evidence.
11. Existing real SO/PO creation, exact SO description synchronization, native-unit
    validation, pallets, stage filters, privacy and real Dispatch guards retain
    their current tests and behavior.

## Failure model and checks

- Lost form data / scroll jumps / autocomplete races: real-browser execution with
  delayed search responses, forced failures and multi-line edits.
- Unauthorized or accidental order bypass: HTTP role/yard/gate tests plus server
  checks inside the skip transaction; gate locks serialize with admin updates.
- Mixed simulated/real orders or invented IDs: DB invariants, service-boundary
  spies and rejection tests for every remote entry path; no simulated handoff.
- Concurrent or stale actions: transaction/revision tests and duplicate/race tests.
- Stage drift: same named stages in domain and SQL view, integration filter checks,
  properties for waiting/closed/completed priority.
- Migration/release drift: additive migration, isolated application and rollback
  compatibility checks, scoped image manifests, private backups and live smoke.

Run the previous full Special workflow suite plus the new backend and browser
regressions. Record types, lint, coverage, manual mutation, randomized suite order,
secret scan and actual browser results. Record limitations explicitly, including
that no live NetSuite write is submitted for verification.

Full-suite contract update: the existing SO-domain test also required the two
contact fields, and the Admin tests enumerated the exact gate inventory (38
writable gates). These assertions are superseded by scenarios 1 and 8: address
remains required, blank contacts are accepted, and the new test gate is the 39th
writable gate. The exact inventory assertions remain in place with that addition.
