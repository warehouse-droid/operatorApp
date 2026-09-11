# NetSuite IR split-reference reconciliation — Tier 3 evidence

Status: final gate passed; deployed and verified on September 8, 2026 at
19:54 UTC. Spec approval was not obtained during the autonomous run. The
evidence demonstrates the stated constraints; it is not a claim of absolute
correctness.

Specification: `test/scm-ir-split-reference-reconciliation-spec.md`.
Entry point: `bash server/tools/scm-ir-split-reference-gauntlet.sh` from the
repository root.

## Root cause confirmed against production

NetSuite links Item Receipts to a source purchase order, while each receipt's
`memo` identifies the user-created split child. The old reconciliation path did
not import that memo. It allocated source receipts by NetSuite receipt location,
which is often the vendor/source yard rather than the user's split destination.
For POB03658 this made valid receipts appear unallocatable or over capacity.
Accepting the review only accepted the current evidence fingerprint; a later PO
refresh or new split changed the fingerprint and reopened the same false review.

At final replay, POB03658 had 43 distinct live receipts. All 43 memos resolved
unambiguously to an active child under source PO 936958, and their per-item
quantities fit the corresponding split ledgers. Multiple IRs for one child are
valid when product and pallet postings are separate and the cumulative line
capacity is respected.

The implementation imports and durably stores `transaction.memo`, matches it
against current and historical split references, and allocates that receipt
only to the named child. Unknown, foreign, cancelled, ambiguous, and
over-capacity references remain fail-closed. BWS blanket receipts without a
usable reference may use location evidence only when exactly one unfinished
child can consume it; ambiguous same-location candidates remain in review.

User-owned split destinations and operational status have precedence. Existing
HOLD children remain HOLD. Genuine Driver completion remains Completed and is
not reverted to HOLD. POB03658's source-family status remains Partially Done
because 93,415.56 of 185,667.17 is received; that rollup is distinct from each
child's user/Driver status.

## Requested replay

The integration replay reconciles a source with a referenced wrong-yard IR,
then performs a later source-PO refresh and creates a new HOLD split child. A
second reconciliation must keep the historical receipt on its original child,
leave the new child at zero, retain both HOLD statuses and destinations, and
produce no review. The preserved pre-feature image failed this scenario; the
final implementation passes it.

The production replay fetches current NetSuite headers and linked transactions,
stores evidence and reconciles each family twice inside a transaction forced to
roll back. It asserts no memo ambiguity/overflow, no location mutation, stable
second-pass state, and preservation of every pre-existing HOLD child.

Before deployment, POB03658 passed both rollback-only passes with status `ok`,
an empty reason, 43/43 exact memo matches and no conflicts. After the real
targeted repair, the same two-pass replay passed again from the live app
container. This directly checks that unchanged evidence does not recycle the
previous review.

## Final fresh verification

| Gate | Result |
|---|---|
| Focused feature suite | 33/33 passed, including migration, query contract, BWS fallback, HOLD/location authority, and later-PO/new-child replay |
| Existing allocator suite | 28/28 passed |
| Repository/query harnesses | Both passed |
| Coverage | 100% statements, lines, and functions; 92.95% branches for `scm-ir-split-reference.js` |
| Mutation | 12/12 full-suite mutants and 4/4 property-only mutants killed; source hashes restored |
| Lint/types | Scoped lint passed; feature added zero type diagnostics relative to the preserved baseline |
| Secrets/source state | 20 paths scanned with no high-confidence finding; final source-state hash `7d379752dcf65d70c0d93fd4a491a334f83dd37667cdc6c73ca3bf7e2c837cee` |

The repository-wide type graph still has the same four unrelated dispatch test
diagnostics in both the preserved pre-feature image and the candidate. A broader
20-test reconciliation integration run had one failure,
`POB03658: a matched parent update plus a new Driver-completed split...`, caused
by `DISPATCH_ACTIVE_LOAD_LOCKED`; the identical failure reproduced on the
pre-feature image, so it is recorded as existing and was not changed here.

No dependencies or lockfile entries were added. The existing dependency audit
reports four vulnerabilities (three moderate and one high); this change neither
introduces nor resolves them.

## Production application and audit

Migration `196_scm_ir_split_reference.sql` added one nullable text column and
completed while the old image remained live. App and webhook-worker were then
recreated only, completing the cutover in about two seconds. Both run image
`sha256:ada4ac9ce709f8af5058ea31c56021e8cb54efd045f4e8e79953d59807647eae`;
the app is healthy, the worker is running, both have zero restarts, and `/health`
returns HTTP 200. The rollback tag is
`mbbs-operator-app:pre-scm-ir-split-ref-20260908`.

Guarded production reconciliation runs 1521 and 1522 succeeded:

- POB03728 changed from the sole open stale destination review to
  `Completed/ok`, with no reason.
- POB03658 is `Partially Done/ok`, with no reason, zero open reviews, and all 43
  live IR snapshots carrying memo evidence.
- The repair compared 129 active split-line authority rows before and after;
  every schedule status, header/line destination, and schedule identity was
  unchanged.
- Final POB03658 child counts are 37 HOLD, six Completed, and five Queued.
  SN1399365 is HOLD. SN1399496 and SN1399520 are Completed with durable Driver
  job evidence dated September 1 and September 2 respectively.
- Final read-only audit found zero open PO reconciliation reviews globally.

POB03774's prior review was already resolved. Its IR14474 memo references
SN1399744, which is not a local active child, and the two active location-1
candidates are not unique. The new policy deliberately does not guess in this
case; a future evidence change would fail closed rather than misallocate it.

Git base: `bfa00f4f674da517d06e82439f0d7af8d27c392f`. Unrelated dirty dispatch
work was preserved and excluded from the scoped production image.
