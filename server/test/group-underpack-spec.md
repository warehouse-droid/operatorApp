# Delivery packing conversion rounding

Spec approval: not obtained (autonomous run). User authorized a general fix,
isolated replay of at least 1,000 sales orders, and automatic resolution of tiny
conversion remainders to the corresponding pallet/layer quantity.

Tier 3: packing status affects warehouse execution. Apply the existing 0.1 sales
unit loading tolerance only to converted lines with packed quantity. A residual
must also be smaller than the smallest positive package conversion, so a whole
missing pallet, layer, section or piece is never dismissed as rounding. Preserve
the existing 0.000001 numerical epsilon. Compare at six decimal places, matching
the repository's quantity precision.

## Acceptance scenarios

1. Reproduce SOB120124 + SOB120358: all five lines packed, including 8 layers at
   11.657 SQFT against 93.26 SQFT. Individual and grouped detail/list show Packed,
   underpack_count=0. The group is absent from the active packing list.
2. The same conversion rule applies to standalone and grouped SOs and outbound
   TOs, including quantities already partly loaded. Loading continues to close
   the sales quantity using the existing loading tolerance.
3. Removing one layer keeps the order underpacked. A residual over 0.1, a whole
   small package, an unpacked line, and sales-only fractional shortages remain
   open. One member's overpacking cannot hide another member's shortage.
4. Randomized integer-based quantity cases give matching SQL and grouped JS
   results, including both tolerance boundaries and floating-point subtraction.
5. Replay at least 1,000 actual delivery sales orders in an isolated database;
   compare all line quantities and order classifications with an independent
   decimal oracle. Record rounding corrections, genuine shortages, and errors.
6. Production verification is read-only. Order quantities, inventory, dispatch
   execution, Receiving and NetSuite are unchanged by status reads.

## Failure model and constraints

- False completion: explicit real-shortage controls and independent properties.
- SQL/group divergence: test both repository paths and order-list membership.
- Floating-point boundaries: decimal/integer oracle, tolerance boundary cases.
- Hidden member shortage: preserve per-source-line group evaluation.
- Accidental business writes: read-only capture; isolated replay; before/after
  row equality; release contains only reviewed runtime files, no migration.
- Unrelated regressions: full MBT suite, relevant Dispatch/reload/quantity tests,
  and type-check compared to the existing baseline; zero new failures.

Setup uses existing Node/PostgreSQL/Docker/fast-check/c8/ESLint tooling. No new
dependencies or git writes. Add tests, replay/deployment tools and evidence.
Run RED, GREEN, types/lint, changed-line coverage, 5 manual mutants (also against
properties alone), randomized focused tests, full suite, live read-only checks.

## Boundary addendum

An exact 0.1 difference can evaluate as 0.100000000000008 in JavaScript. The
existing load and whole-package conversion comparisons must use six-decimal
quantity precision too: 8 x 11.657 against 93.356 loads exactly 93.356; 93.156
converts back to 8 layers; 93.155999 remains outside the tolerance. Verify these
in the server and Operator PWA. Update the PWA asset versions for the changed
conversion helper. No tolerance increase or stock quantity rewrite is allowed.
