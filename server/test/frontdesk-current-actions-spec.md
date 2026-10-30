# Front Desk current actions and responsive selection

Spec approval: user explicitly requires new actions to use the new rate card,
while unfinished orders continue. Implementation details are autonomous.

- A contract accepted under version 1 keeps its original price and snapshots
  after version 2 activates. A newly priced add-bin, exchange or bin change uses
  the active version of the same card; a different card is rejected.
- Loading the action price form refreshes its current configuration even when
  the page or contract was opened before a rate update. The server resolves the
  authoritative version again for preview. The preview's exact price can be
  confirmed after a subsequent retirement without repricing accepted work.
- New collection/exchange actions retain the current garbage per-tonne tariff
  at initiation. Completion uses that evidence even after a subsequent update;
  already prepaid fixed dump charges stay prepaid. Missing configuration remains
  an explicit billing-review result, never a fabricated price.
- Customer and contract clicks immediately show selection/loading feedback.
  Changing customer clears the previous customer's contract details. Late
  responses and failures from superseded selections cannot replace the current
  selection. Failed loads remain retryable and are not reported as success.
- The customer chooser requests compact contract summaries, and the contract
  view receives its charge history in the timeline request. Existing API readers
  retain their full customer-contract response unless they request summaries.

Failure model: stale rate selection, unrelated card substitution, repricing
previously accepted work, tariff changes during unfinished collection, stale
customer/contract responses, duplicate requests and hidden load errors. Verify
with real database lifecycle tests, delayed browser responses, boundary/property
checks, deliberate mutants, static checks and changed-line coverage.

Use the existing bounded disposable Docker runner and installed tools. No new
dependencies, schema migrations, commits or production test orders. Deploy only
the scoped diff over the captured live image. Clean all task-owned test resources
and retain concise source evidence plus operational audit records.

Legacy collection visits without a saved rate use the tariff effective when the
collection was requested (or its visit was created), not when the truck finishes.
Rescheduling an existing request preserves its saved price.
Opening a new BIN quote or aggregate order also refreshes the workflow choices,
so a page left open across activation can select the newly active version.
