# Direct Operator IF/IR using stored orderLine

Tier 3. Spec approved by the user's “Implement the plan” after the proposed plan.
Baseline: 8640191. Use existing Node 20, PostgreSQL 18, Docker, node:test,
fast-check, c8, TypeScript, ESLint and Playwright. No new dependencies or automatic
commits. Deploy app and webhook worker together after zero-new-failure regression.

## Executable acceptance criteria

1. Recent successful SO/PO webhook mappings match stored stable keys and items;
   report TO as unverified until an updated TO webhook arrives. Discover all
   incomplete orders with existing eligibility rules, reconcile SOA08816's removed
   line through existing sync, fill missing mappings with compare-and-set writes,
   preserve operator progress and split inheritance, and repeat with zero updates.
2. Direct mode uses persisted positive safe-integer orderLine, exact stable-key/
   item/split-ledger mapping and real positive parent IDs. Never guess by SKU,
   row position, line unique key or the legacy TO offset. Keep inactive PO history
   excluded and reject unresolved active identities.
3. One compact current-source query per command reads identities, locations,
   closed status and progress; it performs no linked-history query or REST source
   read. Share source data across grouped/consolidated targets. TO receipt remainder
   is shipped minus received; SO IF/PO IR remainder is ordered minus completed.
4. Post exactly the confirmed quantities or fail for review. Reject quantities
   above remaining, closed/deleted lines and stale identity. Never silently clamp,
   count unrelated history as completion, or mark a failed posting locally done.
   Deselect unselected eligible lines; omit completed/closed transform lines.
   Preserve receiving memo and custbody9 references, including SN1400625.
5. A durably fresh command skips remote duplicate scans. Resumed/uncertain commands
   look up their exact external ID; a missing recovery result cannot cause a second
   transform. Keep request-id replay, leases and existing local claims; add parent
   source claims across sibling splits. Maintain legacy command compatibility.
6. Verify the created record by ID, source, external ID, transaction type, positive
   lines, quantities and locations. Fill transaction type from the known REST
   endpoint only when omitted; explicit conflicting types still fail.
7. Independent direct steps use at most three concurrent Operator requests;
   same-source work is claimed once. Observe all in-flight outcomes before deciding
   batch success/attention. Partial batches never finalize locally.
8. Render actual posting progress before admission. R2 uploads remain durable and
   occur after verified completion. The screen waits for confirmation; after 15s
   report a delay rather than success or an automatic repost. Existing local-only
   and driver-completion ownership behavior remain unchanged.
9. Benchmark single source and five-source consolidation under controlled NetSuite
   timings for confirmed completion within 15s and local overhead <=2s. External
   delays may exceed 15s by the user's explicit choice to await confirmation.
   Keep per-stage timing, queue and recovery evidence; no secrets/photo data in logs.
10. Keep HTTP request/job contracts. Version the new immutable internal snapshot;
    use an environment rollback switch, default off until release activation.

## Failure model and evidence

- Wrong source/item, missing/deleted lines, duplicate SKU, TO physical-row aliases:
  unit + property + real database fixtures and live GET/query-only replays.
- Overage, unintended default lines, lost memo/reference: payload and boundary tests.
- Double posting, stale worker, sibling split race: real database claims/attempt
  tests, restart/timeout recovery tests, and independent mutation kills.
- Partial remote success or failed local finalization: service state-machine tests.
- Queue starvation or excessive parallelism: bounded scheduler stress and benchmarks.
- UI/photo delay and premature success: browser/VM flows with delayed HTTP and R2.
- Regression: unchanged baseline versus final full suite, zero new types/lint errors,
  every changed executable line exercised, domain branch coverage, independent
  unit/property mutant runs, randomized test order, diff/secret review.
- No production transaction is created merely to test. Live completion latency
  must be measured from normal operator work after deployment, not invented.

## Approved revision — remove live quantity checks

The user explicitly selected “Remove the live check; let NetSuite decide”. This
supersedes criteria 3 and the live remaining-quantity restriction in criterion 4.
Fresh posting performs **transform then verification**, with no source/history or
duplicate lookup. Use the stored parent-line inventory and orderLine mapping;
send the exact confirmed positive quantity without clamping or rejecting it against
cached remaining/ordered quantity. NetSuite accepts or rejects the request. Keep
local eligibility, identity, yard, split-ledger and duplicate-request validation.
Use cached progress only to omit completed unselected static-sublist lines; a
selected line is sent exactly and a NetSuite rejection requires refresh/review.
An absent/stale webhook can cause rejection; only verification of the exact result
permits local completion. External changes and NetSuite acceptance of overages
are known limits of the explicitly selected no-live-preflight behavior.
