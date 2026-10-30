# Regular stock: Add item

Spec approval: not obtained (autonomous run). The requested behavior is implemented
within the existing stock-request workflow; no dependencies, schema changes, or
Git commits are planned.

1. Sales sees a purple **Add item** button below the existing items, matching the
   Special Order button, for active regular Pickup, Stocking Transfer and Stocking
   Purchase requests before order processing. Legacy regular requests use the same
   rule. SO-based Delivery, single-item Waitlist and Backorder retain their own flows.
2. The matching confirmation dialog explains that submitting additions returns
   the request to **Pending SCM**. Cancel and Escape make no changes.
3. The addition form reuses regular item search, source-yard selection and pack /
   sales quantities. It edits only new items, with Add another item and Cancel.
   Existing header, destination, item identities, quantities and stock evidence
   remain intact. Errors retain the new item inputs for retry.
4. Successful submission appends the new items atomically, resets all existing
   reviewable lines to submitted, clears prior approval/expiry and waiting-for-Sales
   markers, increments revision once, and records the actor and previous review
   state in history. No automatic approval follows this explicit reset.
5. Closed/cancelled/completed requests, processed lines, linked SO/TO/PO proposals,
   and in-flight handoffs cannot be reset. Both UI and server enforce eligibility.
6. Staff Sales access and existing yard scope apply. Missing/stale revisions,
   invalid items/quantities/source yards, existing-line IDs, and a combined count
   over 100 write nothing. Duplicate submissions and competing decisions serialize
   on the request row; only one operation may use a revision.

Failure model: accidental deletion/overwrite is covered by preservation and
rollback tests; stale/repeated submissions and downstream races by database
concurrency tests; bypassed UI by direct HTTP tests; misleading status by actual
queue/status assertions; mismatched appearance and lost drafts by browser tests.
Use the repository's bounded disposable Compose runner, retained source tests and
concise evidence only. Test containers, volumes, networks and temporary outputs
must be removed and production health verified after every run.

Additional availability constraint: with the availability override disabled,
existing and added quantities for the same item/source yard must be checked
together. A request for 9,995 units plus 10 new units against 10,000 available
must fail without changing the request; the configured admin override still works.

Follow-up scope correction: the user explicitly identified the missing Backorder
button. Backorder is now included by the separate Backorder Add item workflow;
see `backorder-add-items-spec.md`. This supersedes its exclusion in criterion 1.
