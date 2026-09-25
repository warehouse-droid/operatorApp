# Stock return draft SQL hotfix

The running application logs report PostgreSQL `INSERT has more expressions
than target columns` at `insertStockReturn`. Its line insert has 35 target
columns, 36 expressions (including the literal NULL) and 34 bound parameters.
The working tree already has the corrected expression list as part of separate
unreleased Return Authorization work. Release only the one-line SQL correction
over the currently running image; preserve the remaining runtime source.

Assurance: old-coder Tier 3, narrowly scoped to persistence of return quantities
and credit estimates. Spec approval: not obtained (autonomous run under the bug
report). No dependencies, schema changes, gate changes or git commits.

Acceptance criteria and failure model:

1. A saved normal stock draft submits through the actual repository using real
   PostgreSQL. Its source line, item, quantities, policy, reason, note, rate,
   estimate and both JSON snapshots persist in the intended columns. This
   catches SQL arity errors and value shifts.
2. Quality drafts retain two distinct reasons against the same source line.
   Combined stock/PALLET drafts retain both records and their photos.
3. Submission removes the draft only after the complete batch succeeds. An
   injected line-insert database failure leaves the draft intact and creates no
   batch/record/line; a subsequent retry succeeds. This catches partial writes.
4. Retrying a successful submission returns the original batch/records without
   additional records or NetSuite writes. Invalid/excess quantities leave the
   saved draft available. Generated fractional quantities and rates retain exact
   database values and rounded credit estimates.
5. Reproduce the original database error with the saved running source before
   testing the fix. Run focused regression tests and the existing return harness
   on the release candidate. Test the existing workspace workflow separately.
6. Check JavaScript syntax, lint, baseline-relative types, changed-line coverage,
   deliberate SQL/value-shift faults, and source hashes. Record skipped layers
   and any baseline failures explicitly.
7. Prepare a release image derived from the original image ID, with only this
   one source line changed. Verify the image and retain an exact rollback
   image/Compose override. Deployment must recheck that the live source/image
   has not changed, then verify application health and surviving saved drafts.

Use existing Docker/PostgreSQL 18 and Node 20 test tooling on a disposable
internal network. Mock only NetSuite and photo-storage network boundaries.
Never submit or modify a user's actual draft as a verification step.
