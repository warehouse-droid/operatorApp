# PO / TO schedule remarks executable specification

## User outcome

- PO / TO Schedule shows a `Remark` column immediately after `Content`.
- SCM users can update the same local remark from PO / TO Schedule and PO Split.
- A Transfer Order with no local remark displays its latest NetSuite `Memo`.
- Saving a local Transfer Order remark overrides the NetSuite Memo without changing it.
- Clearing the local override restores the live NetSuite Memo fallback.

## Data ownership

`scm_transport_schedule.remark_override` is the only local remark field. PO Split
does not keep a second copy. `transfer_orders.memo` remains the immutable local
projection of the current NetSuite Memo.

The effective value is:

1. a non-blank local `remark_override`, otherwise
2. for TO only, a non-blank `transfer_orders.memo`, otherwise
3. blank.

PO and VRMA rows never inherit a source memo implicitly.

## Safety invariants

1. Planning assignment `notes` and `dispatch_assignment_note` are unchanged.
2. A remark-only write cannot change route, quantities, status, split revision,
   or Dispatch snapshots.
3. A planned/linked/received split may accept a remark-only write, while the
   existing operational split blocker continues to reject every operational edit.
4. Schedule optimistic concurrency applies to remarks. A stale editor receives
   `SCM_SCHEDULE_STALE` and cannot overwrite a newer remark.
5. Local remarks are trimmed, preserve internal newlines, and are limited to
   2,000 characters.
6. Blank local input is stored as `NULL`, so a TO resumes following NetSuite Memo.
7. The effective remark participates in Schedule search.
8. Every remark write uses the existing SCM schedule audit/event path.

## Acceptance examples

| Kind | Local override | NetSuite Memo | Display | Source |
| --- | --- | --- | --- | --- |
| TO | `Call yard` | `Internal transfer` | `Call yard` | local |
| TO | blank | `Internal transfer` | `Internal transfer` | netsuite |
| TO | blank | blank | blank | none |
| PO | `Bring straps` | ignored | `Bring straps` | local |
| PO | blank | `PO memo` | blank | none |

## Verification

- Domain unit/property tests cover precedence, normalization, patch isolation,
  and length boundaries.
- UI contract tests cover column order, Schedule editing, PO Split editing,
  locked-split remark-only save, and cache keys.
- Database integration verifies migration, TO Memo fallback, local override,
  clear-to-fallback, optimistic concurrency, and operational-field preservation.
- Existing PO Split, Schedule status, reconciliation, grouping, and migration
  suites remain green.
