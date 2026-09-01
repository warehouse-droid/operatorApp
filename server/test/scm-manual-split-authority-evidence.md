# Manual SCM PO split authority evidence

Date: 2026-08-31 UTC
Specification: `test/scm-manual-split-authority-spec.md`

## Result

The POB03658 recurrence and split-child status defects are fixed in production.
An accepted reconciliation conflict now remains resolved while its material
evidence is unchanged. Active manual PO split schedules retain operator status,
split-confirmed destination, and exact active dispatch planning across
reconciliation and acceptance. Canonical completion remains authoritative.

## Recurrence root cause

- Case 311 was not being reopened by a user action. Reconciliation run 896 was
  created at 2026-08-31 21:07 UTC by
  `scheduled-stale-scm-status-refresh`, with trigger `backfill`, scope
  `order_family`, and target `POB03658`.
- The status-refresh poll runs every 15 minutes, considers schedule evidence
  stale after 6 hours, and applies a 1-hour recent-attempt fence.
- The old review upsert unconditionally reset a matching accepted case to
  `open` whenever automatic reconciliation saw the same allocation conflict.
- The underlying evidence remains a real conflict: 408 received units at
  location 1 cannot be allocated to an active split destination for
  `UNI-BH80S-RDM-FOS`, and observed progress exceeds current split capacity.
- A deterministic SHA-256 fingerprint now covers the material lifecycle,
  routing, family quantity, target capacity/allocation, and line evidence.
  Identical accepted evidence remains resolved; changed evidence reopens.

## Corrective implementation

- Exact manual-child statuses terminate linked-parent status fallback in the
  PO Split catalog.
- Acceptance preserves split schedule revisions newer than the review.
- `Planned` remains authoritative only while an exact active dispatch
  assignment exists and the derived outcome is non-terminal. A stale Planned
  value still follows receipt evidence; exact completion still wins.
- PO/TO Schedule, catalog list, and catalog detail use the same active-plan
  precedence.
- The repair tool validates exact source, full active-family count, named child
  membership, exact current status, confirmed destination, and—for Planned—an
  exact active assignment. It is transactional, auditable, and idempotent.

## Verification

- RED reproduced the active-plan acceptance regression and the guarded Planned
  repair requirement before implementation.
- Final affected suite: 50/50 passing, including reconciliation automation,
  split receipt allocation, exact completion, wrong-yard review, schedule
  performance, PO Split projection, and UI provenance contracts.
- ESLint: zero warnings on all changed implementation, repair, test, and
  mutation-runner files.
- Mutation score: 33/33 killed (100%); the isolated runner restored every
  source exactly.
- Immutable v5 server import passed against the isolated database before the
  successful cutover.
- A current authoritative NetSuite replay ran inside a forced-rollback
  transaction. Its scheduled-equivalent result was `reconciliationStatus: ok`
  with child statuses Hold / Planned / Planned / Hold, while persisted case 311
  remained resolved.

## Production outcome

- Case 311 is resolved with action `accept`, zero open review cases, and current
  accepted fingerprint
  `e1c4889e4a89ff8d42cbe4ca54d401fea5c845579561d800f71f465688b7f6db`.
- `SN1399365`: Hold.
- `SN1399496`: Planned, backed by its active dispatch assignment.
- `SN1399520`: Planned, backed by its active dispatch assignment.
- `SN1399548`: Hold.
- Both PO Split and PO/TO Schedule return those same statuses. All four are
  unblocked and use split-confirmed destination `3445`.
- The v5 repair changed exactly SN1399496 and SN1399520 from Partially Done to
  Planned and emitted two `scm.manual_split_authority_repaired` audit records.
  Its final guarded rerun proposed zero changes.
- Raw active-family state: 38 children; 36 Hold and 2 Planned; every child
  baseline is Hold and every schedule destination matches its split
  confirmation. There are 30 canonical completion records.

## Cutover

- Final image: `mbbs-operator-app:manual-split-authority-20260831-5`.
- Digest:
  `sha256:b895576cb9c3d35467ad9b2d744f63bbf931f9cec891226c6681165434e5793c`.
- App-only cutover is running healthy with HTTP 200.
- The first v5 attempt exposed an unrelated concurrent `server.js` import in
  the broad overlay. It was immediately rolled back to healthy v4 before any
  v5 repair write. The final image was rebuilt from v4 with only seven reviewed
  files, passed an exact import smoke test, and then cut over successfully.
- Rollback file:
  `/tmp/mbbs-manual-split-authority.rollback-v5.compose.yml` (v4).
- The successful cutover stopped unrelated scheduled run 899 for POB03535
  during linked-transaction fetch. Its sole target remained `pending`, with
  zero reconciled orders and zero linked transactions stored. The standard
  scheduler will mark the dead worker interrupted after its 30-minute stale
  lease; manual cross-order recovery was intentionally not performed without
  separate authorization.

## Final protected-data snapshot

| Data | Final evidence |
| --- | --- |
| Parent PO hash | `56edc09e5826e525341b194d741aa4ee` |
| Split header hash | `b9f753a220a5dd9169115147298374a1` |
| Split line hash | `a16f7602a916131cd8e8344e46f9cbee` |
| Child line/receipt hash | `e608ab390cd7ba002548b46420d8acef` |
| Reconciliation allocations | 91 rows, `aff63e3d209863c54aba5c6ad873e6e2` |
| Open reviews | 0 |

Run 897 intentionally refreshed current NetSuite/IF/IR evidence before the
final acceptance, increasing reconciliation allocation rows from 86 to 91.
Neither targeted status repair changed quantities, receipts, split ledgers,
dispatch assignments, parent PO data, or inactive children.
