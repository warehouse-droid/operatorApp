# SCM transfer-dependency workflow executable specification

Status: frozen before implementation on 2026-08-08.

## Scope

This specification covers the SCM Auto Transfer page and its server-side NetSuite
Transfer Order workflow. It must not weaken authentication, shortage conservation,
dependency integrity, NetSuite idempotency, or immutable print history.

## Acceptance scenarios

1. **Independent drafts in one Sales Order**
   - Given one dependency batch with two draft proposals,
   - when proposal A is being created and the operator starts proposal B,
   - then neither action is silently discarded, each proposal owns its own busy
     state, and the result for one proposal cannot overwrite the other proposal.
   - Each proposal can create at most one NetSuite TO. A retry after an ambiguous
     response recovers the marked TO instead of creating a duplicate.
   - Every failure is rendered as an actionable error; there is no indefinite
     spinner and no silent no-op.

2. **Newest navigation request wins**
   - Given candidate, tab, or inventory requests complete out of order,
   - when the operator changes tab or selects another Sales Order,
   - then only the newest request may mutate candidates, selection, inventory, or
     batch state. A stale request may finish, but its payload is ignored.
   - Selecting a Sales Order never renders another Sales Order's inventory or
     proposal cards under the selected identity.

3. **Fast Open view**
   - Listing cached Open candidates does not wait for a broad NetSuite allocation
     refresh.
   - A background refresh is scheduled and its eventual event/result refreshes the
     page. Explicit per-order Refresh and Generate remain authoritative and wait for
     their targeted NetSuite refresh.

4. **Created TO quantity revision**
   - A created or printed proposal remains quantity-editable only while its linked
     dependency and transfer-order lines have no packing, loading, delivery, or
     receiving progress.
   - Saving a revision uses an expected revision and request ID, PATCHes the exact
     existing NetSuite TO item sublist, verifies exact item totals, then updates the
     local proposal/dependency quantities atomically.
   - It never POSTs a new TO. Replaying the same request is idempotent. A stale
     revision or an in-progress dependency is rejected with a visible conflict.
   - A quantity revision invalidates the current verification and print pointer but
     preserves every existing print job as history.

5. **Reprint after creation/printing**
   - A created proposal exposes Print when never printed and Reprint when it has a
     prior print job.
   - A reprint first verifies the current NetSuite quantities and creates a new,
     uniquely keyed immutable print job. It must not reuse an already printed job.
   - Failed/uncertain delivery may retry that same delivery job; a deliberate
     reprint after success creates a later job.

6. **Ordering and global search**
   - Open candidates are ordered by latest meaningful local activity descending,
     with numeric Sales Order ID descending and reference ascending as deterministic
     tie-breakers.
   - Without search, each tab lists only its own workflow stage.
   - With search text, the API searches Open, Created, and Completed together and
     returns newest matching results first, including each result's workflow stage.
     Selecting a cross-tab result changes the active tab to that result's stage and
     retains the selected Sales Order.

## Failure model

- Two proposal confirmations overlap or are double-clicked.
- NetSuite creates a TO but the local HTTP request times out before persistence.
- Candidate, tab, batch, and inventory requests resolve in a different order than
  they were issued.
- The local proposal revision changes between render and save.
- A driver/operator starts executing a dependency while SCM is editing it.
- NetSuite PATCH succeeds but the local request is interrupted before commit.
- A print job is already queued, printing, printed, failed, or uncertain.

## Required evidence

- Deterministic UI concurrency tests using deferred promises.
- Repository/service tests for newest-first sorting, global search, optimistic
  revision, execution-progress rejection, exact local quantity propagation, and
  idempotent replay.
- NetSuite transport contract test proving PATCH `?replace=item` is used and POST is
  not used for revisions.
- Reprint-history test proving a later job key/row is created while the old job is
  retained.
- Existing SCM transfer-coverage and order-dependency regression harnesses.
- A persisted mutation run that kills stale-response, global-lock, POST-instead-of-
  PATCH, missing-progress-gate, and print-job-reuse mutants.

## Release constraint

This change is not deployed by this work item. Deployment requires a later explicit
user instruction after the gauntlet is green.
