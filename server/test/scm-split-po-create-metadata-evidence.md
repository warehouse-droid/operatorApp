# Split PO creation metadata — evidence

Date: 2026-08-27

Deployment state: implemented and tested, not deployed.

## RED evidence

The frontend contract was extended first and failed because Create PO Ref did
not render or submit an initial status and remark. The repository contract was
then extended to require atomic schedule metadata persistence.

## Implementation evidence

- Create PO Ref now renders a Status dropdown and a 2,000-character Remark
  field.
- The dropdown contains only manual states: `Queued`, `Urgent`, `Cancelled`,
  `Hold`, `Priority`, `Surplus Only`, and `Book Appt`.
- Live modal values are submitted as `status` and `remarkOverride`.
- The HTTP route forwards both fields to the repository.
- The repository validates both values before creating data and writes the
  child PO, split ledger, schedule status, and schedule remark within the same
  transaction.
- Extending an existing Blanket split preserves its current status and remark.
- The Split PO asset cache key is `20260827-split-create-metadata-v1`.

## GREEN evidence

- Split PO frontend contract: 13/13 passed.
- PostgreSQL Split PO integration, including valid persistence, extension
  preservation, invalid derived-status rejection, overlong-remark rejection,
  and no partial rows after rejection: passed as part of the final 10/10 pass.
- Schedule status/remark neighboring frontend and policy tests passed as part
  of the final 45/45 pass.
- Frontend mutation score: 7/7 killed (100%), including mutants that discard
  the chosen status, discard the remark, or restore a stale cache key.
- Strict ESLint, repository type check, focused secret scan, and diff hygiene:
  passed.

No database migration or new dependency is required.
