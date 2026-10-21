# Receiving purchase orders at each line's yard

Spec approval: not obtained (autonomous run). Tier 3: yard authorization and receipt posting.

1. SN1401728 / POB03969 has a 2967 header, three lines at 2967 and four at 3445 (five pallets). Order search, vendor selection and item search must find it at both yards. Line counts and item matches must use the selected yard.
2. A 3445 operator opens only the four 3445 lines; a 2967 operator opens only the three 2967 lines. Missing line locations fall back to the PO header. A supported SCM destination override retains its existing authority over all lines.
3. Assigned yards remain mandatory. Reads, refresh, confirm, unconfirm, page confirm, photos, recovery and receiving cannot use a foreign yard or a foreign line. A bulk request containing a foreign line is rejected before any draft changes. Multiple-yard accounts explicitly select their yard; legacy one-yard requests continue to work.
4. Receiving uses only confirmed lines at the selected yard. Every other open PO line is explicitly skipped in the NetSuite payload. Five pallets received at 3445 leave 2967 quantities open and the PO partially received; replay cannot receive them twice.
5. Existing TO/CO identity, schedule override, allocation quantities, closed-order rules, receipt progress and order posting claims remain covered by their existing suites. Order-wide claims continue to serialize receipts across yards.
6. No production PO/line edits, grants, NetSuite transactions, migrations or new dependencies are needed to prepare this change. Browser requests carry the selected yard on detail and mutations; updated cache URLs deliver those requests.

Failure model: header-based hiding (database regression), foreign-yard draft mutation (HTTP adversarial tests), accidental whole-PO receipt (payload and partial receipt tests), multiple-yard ambiguity (unit/property tests), duplicate or simultaneous receipts (existing concurrency and progress tests), stale tablet requests (browser wiring regression), unrelated deployment drift (live source hashes and a scoped patch).

Setup: isolated snapshot of the deployed src/public/migrations; existing Node test runner, fast-check, c8, ESLint and TypeScript; isolated PostgreSQL 18 Docker database. Add a pure receiving-yard module, regression tests and a reproducible gauntlet. No package installation or checkpoint commits. Preserve unrelated workspace edits.

Additional boundary cases found during implementation: a missing location on a skipped line must retain the original header location after selecting another yard; completed yard lines must still permit receipt-status recovery; TO yard mismatch errors retain their existing posting error contract.
