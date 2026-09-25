# Local grouped-load latency

spec approval: not obtained (autonomous run)

SOB120487 + SOB120489 became slow when confirming Load after the CO fixes.
Read-only production profiling found each canonical order read materializing
33,787 unrelated sales/transfer lines, spilling roughly 9 MB to temporary files.
The CO guard itself took 6–12 ms. Repeated canonical reads amplify this cost.

Tier 3: a query used by operational writes. Failure model: filtering out the
requested order's lines could hide warnings or remaining quantities; including
another order or inbound TO lines could corrupt progress; removing CO checks or
locks could allow conflicting loads; altering the group transaction could leave
partial writes. Preserve all guards, locks, validation, photos and transactions.

Acceptance criteria:

1. A single order's warning/underpack query materializes only its own outbound
   lines, for both SO and TO. No unrelated lines or temporary-file spill.
2. With approximately the live population (13,000 SOs / 30,000 SO lines and
   2,000 TOs / 6,800 TO lines), a two-child local group load completes in less
   than 1,000 ms. Both child quantities, load records and photos remain correct.
   Measure the complete repository transaction; photo network transfer is a
   separate stage and is not included in this server latency assertion.
3. Warning and underpack counts retain their meaning across empty, partial and
   fully packed quantities; inbound transfer lines never affect outbound counts.
4. Existing grouped identity, CO handoff, concurrency/rollback, underpack and
   consolidation tests continue passing unchanged.
5. Read-only production results for the two affected orders are identical
   before/after, apart from timing. Do not repeat an actual live load.

Setup: existing Node, PostgreSQL Docker image, test image, fast-check, c8,
TypeScript and ESLint. No dependencies, schema changes or git commits. Add a
focused test, reproducible test/check tools, a baseline patch, and evidence.
Preserve all pre-existing work. Any release will contain only the changed app
module over the current production image, with a rollback image and manifest.

## User clarification — reproduce the reported minute first

The operator reported over one minute, not a one-second database regression.
The 1.14-second isolated repository reproduction is insufficient evidence for
that incident. Do not deploy this query optimization as the reported fix.
First replay the deployed frontend and backend for SOB120487/SOB120489 in an
isolated container, capture screen and request timing, and distinguish photo
transfer from local update. A throttled network experiment is only a controlled
hypothesis, never proof of the operator's actual connection or incident cause.
