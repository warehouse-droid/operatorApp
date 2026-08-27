# Authoritative SCM schedule status repair

## Approved execution contract

The user asked for a systemic fix after targeted PO/TO reconciliation left
historically completed rows displayed as `Queued` or `Planned`. This run is
autonomous under that explicit implementation request; a separate spec-review
round was not requested.

The implementation must satisfy these invariants:

1. A Dispatch plan order backed by `scm_vrma_orders` is a `VRMA`, even when a
   retained plan or Driver PWA payload says `PO`.
2. New and historical completed Driver drop-offs for such an order append one
   canonical `VRMA` completion event. Existing immutable, misclassified `PO`
   evidence is retained but cannot project a false PO completion.
3. The kind-only VRMA schedule view uses the same completion projection and
   status filtering as the combined PO/TO/VRMA schedule view.
4. NetSuite `Rejected` is terminal. With no progress it becomes `Cancelled`;
   with partial progress it preserves the real progress, abandons the remainder,
   and cannot return to `Queued`.
5. Transfer-order webhooks receive the same delayed, durable status refresh as
   Sales and Purchase Orders, using NetSuite record type `TrnfrOrd`.
6. A bounded background repair checks only stale `Queued`/`Planned` scheduled
   PO/TO families, yields to operational NetSuite work, and starts at most ten
   targeted families per interval. It must never start a whole-order sweep.
7. Refresh candidates resolve split aliases and active group members to one
   positive canonical NetSuite source family. Duplicate aliases collapse to one
   request; negative-ID/local-only rows cannot consume refresh capacity.
8. A newer exact reconciliation projection such as `Partially Done`,
   `In Transit`, `Completed`, or `Cancelled` is not re-queued merely because
   the underlying saved schedule row still says `Queued` or `Planned`.
9. Driver completion remains monotonic and wins over later schedule edits or
   stale reconciliation state.
10. No existing SO/PO/TO split, group, dependency, direct-ship, snapshot, or
   Driver PWA identity changes except the authoritative VRMA correction above.

## Failure modes to prove

- stale PWA metadata overrides the authoritative VRMA source table;
- immutable correction creates duplicate canonical events on migration replay;
- a completed VRMA disappears from a kind-only `Completed` filter;
- Rejected TOs reappear as operational work;
- the refresh worker uses `PurchOrd` for a Transfer Order;
- a background sweep overlaps operational sync or becomes unbounded;
- local-only rows or already-projected partial rows starve authoritative work;
- a split/group alias is sent to NetSuite instead of its canonical source;
- a newer manual schedule timestamp reopens a Driver-completed order.

## Dependency policy

No new runtime or development dependencies are permitted.
