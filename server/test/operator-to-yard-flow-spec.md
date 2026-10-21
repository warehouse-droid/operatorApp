# Operator yard-to-yard TO flow

Spec approval: not obtained (autonomous run under the user's request to correct
the flow). Tier 3: inventory posting and durable background processing.

## Acceptance criteria

1. An active yard-to-yard TO remains available for local outbound preparation
   regardless of its NetSuite delivery/fulfillment status, until its locally
   packed quantities have been loaded. Closed/cancelled orders remain protected.
2. An unloaded TO is absent from Receiving sources, order lists and item search.
   A local truck load makes it discoverable immediately at its destination,
   including while NetSuite still says Pending Fulfillment. A driver completion
   alone cannot make it receivable.
3. Receiving is limited to the physically loaded quantity. Partial loads and
   receipts retain their immutable quantities; saved receipts cannot be repeated.
4. For an ordinary yard-to-yard TO, IF admission requires durable local load,
   durable destination-yard receipt covering the loaded items/quantities, and
   effective Driver drop-off completion for the captured dispatch scope.
   Missing evidence never consults or writes NetSuite.
5. IR requires the same physical and Driver evidence, plus at least one matching
   IF job, with every matching IF job completed by verified posting. A merely
   queued/failed/uncertain IF is insufficient. Duplicate/retried work keeps the
   existing immutable command/external ID.
6. Evidence is rechecked immediately before a transform. Concurrent workers
   create only one command. Withdrawn Driver completion, wrong dispatch scope,
   invalid source identity or missing physical records prevents posting.
7. NetSuite progress/sync updates accounting facts without marking goods loaded
   locally, erasing packing/receiving drafts, or undoing saved local receipts.
8. Existing direct-to-customer TO/SO dependencies, PO receipts, yard permissions,
   photo requirements and closed-order safeguards retain their contracts.

## Failure model and checks

| Failure | Check |
| --- | --- |
| Early IF / IR, absent evidence | Real PostgreSQL admission and boundary tests |
| Missing Receiving entry or unloaded goods received | Repository list/search/detail and HTTP tests |
| Partial quantity inflated or received twice | Partial fixtures and generated quantity properties |
| Duplicate posting after races/timeouts | Existing durable worker and concurrent admission regressions |
| Remote sync falsifies local milestones | Sync/progress regression tests |
| Other yard or unrelated dispatch evidence borrowed | Authorization and adversarial scope tests |

## Setup

Use existing Node, PostgreSQL, fast-check, TypeScript, ESLint and c8 tooling;
no new application or development dependency. No git commits or live deployment.
Add focused tests, a forward-only status migration if needed, reproducible test
and mutation runners, and an evidence report in the existing test folders.
Capture the original touched sources for baseline comparison. Run tests through
the standard isolated Compose configuration with bounded containers in
mbbs-tests.slice; register teardown before startup and remove all disposable
containers, database storage and networks, verifying production health afterward.

## Additional acceptance cases found during implementation

- NetSuite's received quantity is an accounting fact. It cannot consume the
  destination yard's local receiving capacity or replace its physical receipt.
- Receiving line confirmation rejects an unloaded line and caps its draft at
  the locally loaded quantity; a saved physical receipt cannot be saved again.
- Tracked TOs get destination-line refreshes before a receiving status exists.
  Reapplying the waiting-status migration preserves immutable jobs and snapshots.

## Authorized activation and reconciliation (2026-10-09)

The user requested deployment and reconciliation of all TOs. This supersedes the
original setup's no-deployment scope. Capture current live app/worker images and
private rollback/audit state, apply only this reviewed TO patch, test the exact
release candidates, preserve live environment and unrelated deployed code, then
apply migration 279 and cut over with image rollback on health failure.

Audit every local TO, including historical and direct-to-customer transfers.
Verify current NetSuite header/line and linked IF/IR accounting evidence before
repairing stale local state or resolving jobs against existing transactions.
Do not manufacture Operator records, borrow unrelated dispatch completion,
repost an existing transaction, change captured posting quantities or erase
durable work. Record before/after repairs in operational audits. Transfers that
lack evidence remain waiting or attention; completed historical transfers follow
the user's historical-completion preference. Separate worker checks verify that
its distinct deployed sync/progress code cannot overwrite local milestones.

Historical preference received: keep completion for transfers already fully
fulfilled and received in NetSuite, including their local split children. A
verified Received header closes historical local work without creating physical
load/receipt records. Missing NetSuite identities are held for review. An existing
IF may be attached only when its REST record proves the same source, shipped
state, item, order line, sales unit and exact saved quantity; ambiguous matches
remain attention. Legacy active loads may acquire a posting job only from their
durable snapshots and a unique matching saved dispatch assignment. Per-order
transactions lock and re-read live physical evidence, retain drafts and immutable
posting snapshots, audit repairs, and make repeated reconciliation idempotent.

The user additionally requested both legacy partial transfers, TOB01134 and
TOB01200, in their receiving yards' Receiving module. Save an explicit audited
historical receiving exception backed by verified shipped IF records. Receiving
recognizes that accepted historical shipment evidence and caps each item to its
verified fulfilled quantity. It does not create Operator loading records or
allow generic NetSuite statuses to expose other unloaded transfers. Existing
NetSuite receipt amounts remain separate from local physical receipt progress;
the posting worker retains its physical and Driver guards and existing-transaction
verification. A historical exception never authorizes a duplicate IF or IR.

When one shipment is fully received, other ordered items that have not yet been
loaded keep the Transfer Order partially received. Completion considers every
active receiving line and saved physical receipt progress, including lines with
zero current loaded capacity. Loading the remaining items makes them receivable
later under the same TO, for both ordinary and accepted legacy shipments.

An outbound TO with local completed loading and receiving flags stays out of
open outbound work even when historical cached packing balances are incomplete.
The historical-completion preference never requires inventing quantities or
discarding old drafts to satisfy the outbound list's underpacking calculation.
