# Operator Receiving parent PO split balance

Tier 3: receiving availability bounds inventory receipt drafts.
Spec approval: not obtained (autonomous run). User authorized the Operator
remaining-line correction and deployment. POB06984 was not found locally or in
NetSuite; continue the verified POB03684 incident discussed in preceding turns.

1. POB03684 has 16 active source lines and an active #11619-1 split assigning
   14 line quantities. Operator Receiving must expose only OAK-RKT-SG-1272
   108 SQFT, OAK-PAV-AB-2424 304 SQFT, and OAK-PAV-HL-1224 228 SQFT. The selected
   order card, line pagination and confirmation must agree on those three lines.
2. Deduct active SCM split reservations only from their exact source-row ID.
   Keep split children receivable under their own reference. Multiple active
   splits accumulate; cancelled splits release capacity; other PO/line/SKU
   matches do not transfer reservations. Keep NetSuite source rows and ledgers
   unchanged during read/projection and deployment.
3. Parent availability is bounded by both recorded completion and unsplit
   capacity after its baseline and local receipts. Split quantities already
   reflected in the parent NetSuite receipt counter must not be deducted twice.
   Existing parent local receipt evidence reduces the parent's own remainder;
   duplicate/failed receipts retain their existing behavior. Fully received
   lines remain unavailable. Ordinary sales-order reservations do not reduce
   physical receiving quantities.
4. Confirmation re-reads the same available balance and caps input quantities.
   A stale pre-split confirmation cannot produce a receipt draft above the
   parent's current unsplit remainder. Return only positive remaining lines
   to the UI (retained exceptions/confirmation history stay non-actionable).
5. Preserve transfers, Transit CO, no-split PO receipts, original line identity,
   existing local receipt recording/idempotency, NetSuite posting checks, and
   the previously deployed deleted-line and Sales map fixes. No live receipt,
   confirmation or business-record mutation is performed during verification.

Failure model: reservation deducted from wrong line/child (real SQL fixtures),
double subtraction after remote receipt sync (exact examples + generated
quantities), stale selection/confirmation (browser + draft-bound checks),
over-allocation/negative balances and cancelled/header mismatch (adversarial
cases), backend/UI mismatch (real repository output replayed through Chromium),
lost unrelated changes (patch onto captured live image + hashes + rollback).

Use the existing isolated PostgreSQL/Node/Playwright/fast-check/c8/ESLint/
TypeScript tools; no dependencies, migrations, git commits or resets. Add a
focused domain/repository helper, regression tests, and reproducible validation
and release scripts. Run RED first, focused/neighbor tests, changed-line coverage,
manual and property-only mutants, static checks, shuffled scope, full regression
against the recorded existing-failure baseline, and read-only live verification.
Keep external NetSuite receipt ingestion/configuration unchanged; this correction
projects existing split assignments into Operator Receiving's parent capacity.

Verification clarification: the existing browser form serializes the selected
line's input as string "1" and the other two default quantities as number 1.
The browser assertion requires exactly [1, 1, "1"]; all three are one pallet.
Its first run incorrectly assumed all form values were numbers. No application
behavior or quantity bound was changed to satisfy this harness correction.
