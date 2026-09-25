# CO direct-supply reference lines

User-authorized amendment, 2026-09-17. Spec approval: not obtained (autonomous run).
Tier 3: this changes Operator's delivery API and packing write eligibility.

The operator must see the original Trevista line on CO-SOA08838, with the same
direct-supply notice as a fully allocated normal SO line. Yard 150 must have no
packing requirement or packing controls for that line.

## Executable acceptance criteria

1. After linking 52.25 SQFT / 5 layers Trevista and 1 of 7 pallets to the direct
   TO, CO detail retains Trevista: original 52.25 / 5, direct TO 52.25 / 5,
   Operator requirement zero, `no_yard_load_required=true`, and the existing
   `No yard load required—direct supply` label. Active displays this reference.
2. PALLET displays original 7, linked 1, remaining 6 and remains packable. The
   reference does not increase `underpack_count`; display line count includes it.
3. Existing five packed CO lines remain in Packed with identical saved packing.
   A fully packed CO does not gain an Active workload from a reference alone.
4. Both single-line confirmation and absolute packing writes reject the reference
   with `DELIVERY_NO_YARD_LOAD_REQUIRED` / 409. Rejection leaves canonical CO
   header, packing, confirmations and audit unchanged. A mixed batch reports that
   line's failure and can still confirm the residual pallet line.
5. Normal SO PO/TO behavior, source SO quantities, saved allocations, canonical
   CO cargo, Dispatch pickup/drop cargo and plan revisions remain unchanged.
   Trevista remains absent from physical CO cargo. No database repair is needed.
6. Projection is read-only and idempotent. Generated valid quantities conserve
   original = direct + required in every dimension. Missing markers preserve
   ordinary CO behavior. A stale smaller original must not reduce current cargo.
   Invalid negative/nonfinite marker or residual quantities fail closed.
7. Loaded CO quantities are not reclassified as direct supply; their existing
   loaded projection is preserved. Unlink and refresh remain reversible.
8. Actual Chromium rendering uses the normal Operator row and panel functions:
   the reference shows the notice and original/direct/residual breakdown, no
   packing steppers or Confirm control; PALLET retains its controls.

## Failure model and checks

- Double subtraction / accidental cargo resurrection: quantity properties plus
  real database detail, refresh, and Dispatch manifest regression tests.
- A hidden packable zero line: browser rendering plus both server write paths.
- Rejected write claims order ownership: transaction rollback snapshot test.
- Packing lost or card hidden: existing Packed/Active database/browser tests.
- Loaded underpacking mislabeled as direct supply: explicit loaded exclusion.
- Concurrency: retain existing shared transaction locks and run adjacent packing
  and reconciliation lock tests; this change introduces no new write transaction.
- Corrupt marker: adversarial quantities tested through the shared validated
  quantity projector; source identities/allocations are not modified.

## Setup and verification plan

No new dependencies, migrations, commits, external notifications or data repairs.
Use installed immutable Docker test images, disposable isolated PostgreSQL, and
Chromium. Add scoped tests, a baseline patch, a reproducible gauntlet, mutation
loader, read-only live verifier, scoped release helper and evidence report.
Snapshot the current source before implementation. Hold full tests and types to
zero new failures; record existing failures. Check scoped lint, changed-line
coverage, five manual mutants (also properties alone), reversed test order,
syntax, diff whitespace and secrets. Preserve unrelated working-tree edits.
Deploy only the new projection and delivery integration on the current live
image; verify healthy app and unchanged worker/dependencies and operational data.

Test correction before final validation: batch failures use the existing SO
server message, `TREVISTA requires no Operator yard load because its full quantity
is direct supplied.`, rather than the UI label. The batch test asserts that exact
message; the single-write tests continue asserting the 409 code. No application
message change is intended.

Browser expectation correction: the existing Operator formatter renders zero as
`-`, so the exact display assertion uses `- SQFT`; API quantity assertions remain
numeric zero. The existing formatter is unchanged.
