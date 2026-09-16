# Split delivery address persistence

## Incident and contract

SOA08748-S2 was dropped onto its load with `76 Heatherside Dr, Scarborough, ON M1W 1T7` in audit records 21192 and 21198. Saved plan revisions 41–45 instead contain the parent's `94 Mossbrook Crescent, Scarborough, ON M1W 2W9`. The split edit currently bypasses the details endpoint; plan reconciliation replaces the edit with the global definition, and source refresh/materialization inherit the parent address.

1. Saving an SO split's dispatch details uses the existing details endpoint, after pending split creation is saved. Failure must remain visible; it cannot report success for browser-only data.
2. An active split can save its own address, pickup override, date and windows before or after materialization. Those explicitly supplied fields are authoritative for that split; all destination aliases agree.
3. A parent refresh, stale plan reconciliation/save, catalog reload and repeated materialization preserve the split override. An unedited sibling still follows its parent; cargo, source status and yard freshness continue normally.
4. Editing an override again, including clearing an address or choosing the same address as the parent, persists the explicit choice. Invalid dates fail atomically. Retired splits cannot be edited/reactivated.
5. Plan saves and explicit split edits serialize using the existing fleet lock; source refresh serializes on split rows. A stale snapshot cannot erase the saved override.
6. After refresh, SOA08751 and S1 at Mossbrook and S2 at Heatherside form two delivery visits. Route stop identities/order remain unchanged by reconciliation.
7. The existing details endpoint continues to audit edits and enforce the edit lease. Normal SO, PO, TO, CO and group behavior remains covered by existing tests. No dependency-policy or quantity changes.

## Setup and failure model

Tier 3: loss of operational delivery details and concurrent refresh. Use a disposable internal Docker network and tmpfs PostgreSQL, existing cached Node/Playwright tooling, regression/property tests, explicit stale-save/refresh tests, rollback tests, and manual mutants. No new dependencies, migrations, commits, or production test data. Preserve the dirty-worktree baseline under test-artifacts. Run the relevant Dispatch suites and materialization harness, syntax/lint checks, coverage and capability/diff review. Report unavailable layers explicitly.

Spec approval: not obtained (autonomous run). Proceed under the user's request to fix the concrete bug; confidence is based on executable checks, without independent spec review.

Production correction, after validation: retain Mossbrook for SOA08751/S1 and persist Heatherside for S2 using the tested details path, with a before/after record and no snapshot rollback. Do not infer a route sequence change from address repair.

Correction detail: pin S1's user-confirmed Mossbrook address as an explicit split override too, even though it currently equals the parent, so both specified destinations survive future source updates.

Driver verification revealed that driver routes read the confirmed snapshot. The normal frontend save already updates it after the details endpoint; the maintenance correction must perform that normal plan save too. Replace the earlier blanket snapshot-unchanged constraint with: archive the prior revision, update the two order destinations, and preserve stop identities/sequence, cargo and assignments. Rehearse that save with rollback before applying. Verify the real driver route reader after confirmation.
