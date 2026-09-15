# Sales Order cargo and item identity evidence — 2026-09-11

## Result

Deployed `mbbs-operator-app:sales-cargo-20260911-v1` to the application and webhook
worker. Image digest:
`sha256:ca76f49f6ce50d09560bac9d2461da062df0a38d19ad519d546b6fc8eb972db2`.
The seven changed runtime files match the frozen source hashes used for testing.
No dependency, migration, NetSuite write, or Git commit was added.

The authorized production repair advanced September 11 plan 323 from revision
32 to 33. It reactivated five falsely missing SOB119965 source lines and restored
GOB-119964-119965 to nine lines, eight pallets and five layers. SOB119965 has seven
lines; BWS-GD-CURB-CHAR retains ordered quantity 37. All 21 driver records present
at the repair, all stops/trucks, other orders, the Sales Order header, and source
operational quantities were verified unchanged inside the transaction.

Audit `20207`, action `dispatch.sales_order_cargo_repaired`, records the repair
and its original confirmation evidence (`20096`). The old plan snapshot was
archived. A repeated invocation returned `alreadyCorrect: true`, revision 33.

## Root causes and resulting behavior

The SO queries filtered lines using ordered minus fulfilled quantity. Five
SOB119965 lines were fully fulfilled in NetSuite, omitted by sync, and marked
inactive locally. The refreshed global group therefore lost cargo, while an
already-open browser could still hold the original manifest. The six SO reader
paths now retain ordered cargo, including fully fulfilled lines. Existing order
eligibility rules, PO/TO behavior, and fulfillment-posting capacity checks remain.

Compact item cards omitted item IDs, and grouping did not hydrate every selected
member. Cards now preserve itemId and lineRowId; grouping awaits all required
details and refuses incomplete or changed selections. Legacy allocation checks
resolve missing IDs only when both plans provide an unambiguous SKU-to-ID mapping
within the same order. Actual item, quantity, assignment and driver changes
remain protected. Complete direct CO cargo can still be grouped without loading
informational source children.

## Validation

Repeatable command:

```sh
RUN_LIVE_REHEARSAL=1 bash server/tools/sales-order-cargo-gauntlet.sh
```

Final raw evidence: `server/test-artifacts/sales-order-cargo/final-4VZHA9/`.
The single gauntlet command exited successfully on frozen production source.

| Check | Result |
| --- | --- |
| Focused executable tests | 15 passed; reversed file order also 15 passed |
| Repair database tests | 3 passed: rehearsal, application/idempotency, precondition/rollback checks |
| MBT main suite | 457 files, 2,266 tests passed |
| Legacy compatibility | 134 harnesses passed |
| Driver live route prefix protection | 22 tests passed |
| Planner/catalog/global-group regressions | 51 tests passed |
| Chromium desktop grouping | 2 passed: complete grouping and failed detail fetch |
| Targeted mutations | 9 of 9 killed; 3 also killed by property-only runs |
| Changed executable lines | 197 of 197 covered using Node and browser V8 evidence |
| Lint and syntax | Passed on scoped new/changed modules and test/tool files |
| TypeScript comparison | Identical 233 pre-existing diagnostics; no new diagnostics |
| Secret scan, whitespace, source hashes | Passed |

Acceptance criteria in `sales-order-cargo-integrity-spec.md` map to the single
and batch reader tests, six lookup boundary tests, ordered-quantity property
test, compact/group hydration tests, legacy identity adversarial/property tests,
repair integration suite, and direct CO compatibility regression. Property
tests use seeds 20260911 and 20260912 with 150 runs each.

The repair concurrency test uses an independent PostgreSQL session and proves
that another planning writer cannot take the shared advisory lock while the
repair transaction holds it. Failure injected after source reactivation rolls
back source, catalog and plan changes. Exact revision and line/quantity checks
reject stale or unexpected data before applying a repair.

The six deleted SO SQL predicates do not add executable lines to the coverage
denominator. Their behavior is covered by the reader tests and by real read-only
NetSuite calls through both final single and batch SO detail readers. Those live
calls returned all seven SOB119965 lines, including the eight pallets, five
layers and curb quantity 37.

## Live verification and recovery evidence

The final gauntlet and the deployed image both rehearsed the complete repair
against current data and rolled back. The application was healthy after the
cutover, and the webhook worker started on the same image. Direct and configured
public-origin health and assets were checked; the browser script hash matches
the release file and the HTML includes the new cargo cache version.

Read-only verification after application confirmed seven active source lines,
the exact original seven line/item/quantity tuples, nine grouped lines with IDs,
and equivalent cargo in the stored snapshot, global definition and refreshed
plan. SOB119854 in GOB-119854-119855 also has all seven item IDs on the refreshed
plan. This check invokes the same plan repository used by the API; it does not
perform a production dispatch save or driver action.

Private recovery material is under
`docker/backups/sales-order-cargo-20260911/` (directory mode 0700):

- `database.dump`: complete predeployment custom PostgreSQL dump, 279,125,185
  bytes, checksum recorded and archive listing verified.
- `repair-before-revision32.json`: exact locked before-state, 828,838 bytes,
  mode 0600; also retained in the app data volume under
  `/app/data/repairs/sales-order-cargo-20260911-revision32.json`.
- `repair-applied.json`, `postcheck.json`, `repair-idempotency.json`: committed
  repair, refreshed-data/asset verification and no-op results.
- `compose.rollback.yml`: previous application/worker image override;
  `runtime-source.sha256`: verified release file hashes.

The two temporary test projects created for this task were removed. Existing
replay and other test projects were left running. Images and private backups
were retained for reproduction and recovery.

## Boundaries and iteration record

Tier 3 was used because this changes persisted operational data and concurrency
guards. Spec approval was not obtained separately: this was an autonomous run
under the user's explicit fix-and-repair instruction. That limits independent
review of the written specification.

Initial red tests reproduced missing fully fulfilled lines, lost compact IDs
and incomplete selected-order hydration. Direct CO compatibility received an
additional red-to-green regression before the final frozen run. Test setup was
corrected for an unsupported fixture column, isolation from a concurrently reset
test database, writable V8 artifacts, and a synthetic credential scanner match.
An earlier coverage run was superseded after the final frontend source change;
the final combined coverage has no missed changed executable lines.

The first postdeployment verifier compared raw item JSON byte-for-byte with the
refreshed projection. Existing projection behavior omits zero allocation
placeholders, enriches null inventory conversions as string zero, and
recalculates one floating-point weight. Read-only inspection established these
were the only differences. The private verifier now normalizes those precise
representations while comparing all item fields and exact source quantities;
it passed. No production source or repaired cargo was altered for that check.

Browser coverage is two Chromium desktop scenarios using real Dispatch UI code
and mocked API boundaries, not the entire browser matrix. Global TypeScript is
not clean; its baseline diagnostics are unchanged. Dependency/security/license
refreshes were unnecessary because dependencies did not change. Existing printer
agent credential errors appeared during startup and are outside this cargo fix.
