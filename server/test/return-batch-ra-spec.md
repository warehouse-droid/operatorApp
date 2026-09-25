# One NetSuite RA per confirmed return batch

User requirements (2026-09-18): RB-000004 must post to NetSuite; show the actual
RMA number on the Operator screen; a mixed stock/PALLET return creates exactly
one RA; its receiving location is the operator's active yard (3445 -> 3445,
2967 -> 2967). This explicitly supersedes the earlier two-RA combined workflow.

Observed incident: RB-000004 contains SR-000004 (three separate quality reasons
on SOA08504 line 1, total 45.45 SQFT) and PR-000001 (two PALLETs). Both are local,
accepted, with zero posting attempts; yard 2967's legacy automation is disabled.
The deployed legacy adapter also rejects split reason rows. No RA is yet linked.

Assurance: old-coder Tier 3. Spec approval: user supplied the behaviors above;
this executable specification was not separately approved (autonomous run).
Use existing Node, PostgreSQL, Docker, Playwright, fast-check, c8, ESLint and
TypeScript. No dependencies or git commits. Preserve other workspace changes.

Acceptance and failure model:

- B1: New confirmations admit one immutable batch RA intent, with stock rows
  and an optional PALLET row; preserve each source line/reason/quantity/rate.
  PALLET is $40/Each with GD reason. A combined batch performs exactly one RA
  POST and no Credit Memo POST. A standalone stock or pallet return has one RA.
- B2: Use the authenticated, authorized receiving yard for the header and item
  locations. Cross-yard, customer, source-SO, and policy checks remain enforced.
  A draft cannot change receiving yard. Test all four configured yard mappings.
- B3: Share the actual returned RMA reference across both local records and show
  it on confirmation and history. Disabled, pending and failed posting must not
  look like NetSuite success. Keep rates, credits and private snapshots hidden.
- D1: A batch lock, durable creation marker and stable external ID prevent extra
  RAs for concurrent stock/pallet retries, timeouts, lost responses and restart.
  Persist a discovered ID before readback. An uncertain attempt is recovery-only.
  Definite rejection may retry the same intent. Never create a replacement for
  a known transaction. No record-level fallback may create a second transaction.
- D2: Readback must match customer, receiving yard, source SO, external ID and
  exact row multiset, including units, reasons and rates. A mismatch stays failed
  with the known ID retained. RMA number is read from NetSuite, never fabricated.
- Q1: Shared stock identity avoids double local/remote reservation. PALLET quota
  remains reserved until observed PALLET Credit Memo quantities reduce it; stock
  credits must not release PALLET quota. Reconciliation and void/link guards must
  respect the shared RA, including partial downstream credits.
- G1: Keep admission tied to the policies actually reviewed by the operator.
  Mixed posting is atomic: all included components must be enabled. Capture the
  policy; enabling a gate later must not silently post old local-only returns.
  Explicitly recover RB-000004 only after duplicate lookup and verification of
  its saved intent. Configure automation for the operator's active receiving yard.
- R1: Preserve the fixed INSERT, drafts, photos, previous submissions and legacy
  transaction links. Add an additive shared-RA authority without removing the
  existing uniqueness protection on legacy record transactions.

Verify failing domain/repository/UI tests before implementation, real SQL and
HTTP behavior, generated and adversarial cases, retries exceeding the pool size,
rollback/crash recovery, baseline-relative lint/types, changed-line coverage,
deliberate faults, browser rendering, and the existing return regressions.
Record unrelated baseline failures instead of weakening their tests. Build a
focused release over the current running image, with rollback, then verify the
actual RB-000004 RA and its visible RMA number. Live repair must use the existing
batch, not a replacement submission.

Account verification amendment: the live REST transform rejects repeated
`orderLine` keys with HTTP 400 / DUPLICATE_KEYS before creating a transaction.
Keep the first row linked by its Sales Order line key; add further reason rows
without repeating that REST key and with an exact source-line marker in their
item description. Verify that marker, item, units, reason, quantity and rate on
readback. Reserve any stock quantity not observed through NetSuite's native
source-line links locally, so split rows cannot release return quota early.
This changes the REST encoding, not the requested stock quantities or reasons.

The live RA response also omits `orderLine` on GET. When absent, verify its
native NextTransactionLineLink against the immutable source line ID and source
units before reconstructing the comparison key. Keep failing on a missing,
ambiguous or different native link. RMAB01506 was created once with all four
requested rows; this readback correction recovers that existing transaction.

Final observed lifecycle: NetSuite's UI cancelled RMAB01506 after creation. The
user explicitly said to keep it cancelled. Preserve this state and the same RA
number on confirmation/history; a retry must neither reopen it nor create another.
