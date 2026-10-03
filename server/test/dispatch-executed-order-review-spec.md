# Executed order update review

Spec approval: not obtained (autonomous run). Tier 3: execution history, public API, concurrent writes.

The requested behavior is to accept authoritative source updates, require Dispatch to acknowledge exactly what changed, protect recorded execution, and prevent blank address overwrites. This extends the earlier prefix-lock specification: source updates may be acknowledged; changing the physical route still cannot be overridden.

## Acceptance scenarios

1. Given executed TOB01111 with line 4977214 / PER-MM80S-2237-SCG at 326.48 SQFT and PALLET at 29 EACH, when the source removes that line and changes PALLET to 25, show both changes, order, driver, truck, load and affected stops. Label calculated pallet totals separately from NetSuite quantities. Do not claim that the source edit occurred after execution without timestamp evidence.
2. Source information remains authoritative regardless of acknowledgement. Saving more work requires acknowledgement of the current source version. Acknowledgement records the actor, time, changes and version in the database. Refresh/restart does not ask again for the same version; subsequent changes require another acknowledgement. Forged or stale tokens fail.
3. An acknowledged source refresh may be reconciled with the recorded order snapshot when saving new work. Recorded stops, assignment, sequence, times, job records and photos remain unchanged. An arbitrary dispatcher edit, removal, reorder or reassignment still fails with precise changes; acknowledgement cannot bypass the physical prefix lock.
4. Given GOA-8930-8931 with a valid address, a blank group/child address from refresh preserves the valid address recursively. Dispatch shows the order and retained address. An explicit blank address submission is rejected in the form and API; omission of the address in a partial update preserves it. Group updates are atomic. No false claim that this draft loss was a NetSuite edit.
5. Warnings enumerate all affected orders/fields, including removed/added items and before/after quantities, address, stop membership/order, assignment and timing changes. HTML is escaped. Dispatch explicitly confirms the displayed updates; acknowledgements preserve unsaved future work.
6. Pending reviews are discoverable on plan load and on save, including when the browser has retained older execution data. Source lookup failures fail the save visibly instead of silently accepting edits.
7. All plan save entry points retain their existing prefix enforcement, revision fences and edit leases. Acknowledgement requires dispatcher authorization and the plan edit lease. Concurrent/stale confirmations cannot acknowledge a newer source version.

## Failure model and verification

- False source attribution / fabricated browser data: query the server mirror and test mismatched payloads.
- History loss / overly broad override: replay the incident; assert exact job/stop preservation and hostile route edits remain blocked.
- Lost address in nested groups: frontend refresh plus backend group, split, details and plan boundary regressions.
- Races / partial writes: transactional acknowledgement, stale-token and grouped rollback integration cases.
- Repeated warnings / stale confirmation: persisted versioned acknowledgements, reload and second-source-version tests.
- UI bypass / injection: authenticated HTTP tests and real browser warning/confirmation/form checks.

## Setup and boundaries

No new dependencies, git commits, resets or staging. Preserve unrelated workspace edits. Add a migration, domain/repository/UI code, regression tests and a reproducible isolated Docker runner/evidence report. Use existing Node, PostgreSQL, Playwright, fast-check and c8 from test images; internal test networks cannot contact NetSuite. Capture pre-change sources to compare existing suite failures. Run RED, focused/full relevant suites, static checks, coverage, manual mutations, property/race/adversarial tests and real endpoint/browser checks. Record any inapplicable or unavailable layer honestly. Production deployment is a separate final action after the implementation is concrete and verified.

## User clarification — 2026-09-20

“the main point is, the netsuite update prefix stop should not block dispatch planning save”

This supersedes the save prerequisite in scenarios 2 and 3: source updates verified against the server mirror must not block saving later work, including while their warning awaits confirmation. Confirmation is a separate, persistent review obligation, never a save gate. Save the observation independently so a successful plan save/reload cannot erase an unconfirmed warning. A newer source version produces a new warning. Source changes do not authorize arbitrary manual edits to the physical prefix. Source lookup failures still report the actual error rather than silently accepting unverified edits.

## Address compatibility clarification

The requested no-blank rule also supersedes two older tests that deliberately cleared a valid SO address from an empty split override or server acknowledgement. Their replacement assertions require retaining the address and its aliases. A PO delivery override may still be reset to its mapped yard only when that mapped destination has a nonblank address; this does not leave the effective delivery address blank.

## Execution snapshot clarification

Accepted source changes remain authoritative in the source order and are displayed in the persistent review. A verified refresh in a save payload is reconciled back to the recorded execution snapshot for protected order fields. This preserves driver route/job identity when a source address or pickup yard changes. The source is not reverted. Future orders and loads still save normally. Unverified manual changes are not reconciled away and retain the existing hard lock.

The same rule applies when the browser copies verified source address, yard or whole-order quantity changes onto an executed stop. Restore only values whose before/after pair matches the recorded order and current server source; unrelated stop fields, stop membership and route timing keep the hard lock. Snapshot restore must reconcile source data before materializing pickups, just like both normal save paths.

PO address metadata has a separate meaning: its raw `dispatch_address` is the supplier pickup, so retaining a delivery address must not populate that field or invent a delivery override. The PO vendor pickup remains unchanged.
