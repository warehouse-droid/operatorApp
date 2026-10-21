# Count sheet inventory refresh

Tier 3: stock snapshot integrity, yard/owner authorization and concurrent reset.
Spec approval: not obtained (autonomous run); the user's request authorizes the
feature, and these acceptance details remain available for review.

Opening/taking/resuming an in-progress sheet, automatic resume after reload, and
its Refresh button must fetch the assigned SKUs at the sheet's yard before
counting is enabled. Completed sheets remain historical reviews. No new package,
migration or checkpoint commit is needed. Use existing Node/PostgreSQL/Playwright,
ESLint, TypeScript, c8 and fast-check in isolated containers. Preserve unrelated
workspace changes and deploy only a tested patch over the current live image.

Named acceptance scenarios:

- S1: a sheet with items A/B at yard 1 fetches exactly A/B at yard 1, updates
  their cached balances and conversions, and leaves item C and yard 28 intact.
  A subsequent count uses the refreshed on-hand balance and sync timestamp.
- S2: network failure, missing rows, duplicate rows, wrong SKU/yard or invalid
  quantities fail visibly and leave all cached balances unchanged; retries work.
- S3: foreign-yard/other-owner requests fail before NetSuite is called. Sheet
  reset, cancellation or concurrent edits during refresh invalidate the result.
  Slow NetSuite does not hold a database transaction or block a manager's reset.
- S4: refreshing does not change confirmed count snapshots, attempt, revision,
  ownership or NetSuite stock. Submitted/cancelled reviews do not call NetSuite.
- S5: large sheets use bounded batches of at most 180 distinct SKUs; all batches
  validate before any cache writes. Generated SKU lists preserve exact scope.
- U1: Take, Resume, automatic resume and Refresh all refresh before enabling
  counting. Delayed/failed refresh shows progress/error and a working Retry;
  no count can be entered with a failed refresh. The count remains blind.
- U2: leaving the module while refresh is pending prevents late responses from
  reopening the old sheet or replacing the new screen.
- R1: existing sheet claims/counts/submission, regular Cycle Count, Damage Stock,
  Control review and API authorization keep their existing behavior.

Failure model: wrong/partial stock updates (SQL integration + hostile replies),
stale owner/reset races (deferred network concurrency tests), frozen UI or stale
navigation (Playwright), hidden failure (visible retry assertions), overbroad
sync (exact request assertions + generated cases), deployment drift (live image
and source hashes). The remote API remains read-only; local writes refresh cache
only. Historical on-hand at an unrecorded instant is not inferred from current
stock without transaction evidence.

Additional user request: retrieve current on-hand for every SKU on HUNT 20261002,
compare it with its stored snapshot, and report the observation time. Do not
silently replace already confirmed snapshots with today's inventory.

## Scope addition requested by the user

Both Cycle Count and Count Sheet reviews must show On hand, Packed, Actual on
hand, Counted and Var. Operator entry stays blind (explicit user choice).
Actual on hand = on hand - remaining physically packed quantity at that yard;
Var = counted - actual on hand. Packed means recorded packing, not all NetSuite
commitments. Exclude shipped/fulfilled/cancelled stock and subtract partial
fulfillment once. Include active SO, outbound TO, local CO, vendor-return and
reload packing; aggregate source lines once, not grouped display projections.

- P1: on hand 767.24, six pallets at 102.3 plus six layers at 12.79 packed,
  and counted 63.95 yields packed 690.54, actual 76.70, variance -12.75.
- P2: other yards/SKUs, inbound TO, closed orders, completed local transfers,
  fulfilled units, duplicate group displays and reservations without packing
  contribute zero; partial fulfillment and stock-UOM conversions are tested.
- P3: both confirmation functions freeze packed quantity, actual on hand and
  observation time together with the existing stock comparison. Historical
  records without a packed snapshot show unknown, not a fabricated zero.
- P4: both Control reviews show the five columns, with positive/negative
  variance rendered consistently. Operator count entry remains blind.
- P5: reconstruct HUNT 20261002 from current verified stock and recorded counts,
  persist an audit of the original comparison, and mark the revised comparison
  as current reconstruction. Preserve counted values, counting operator,
  confirmed/submitted times and ownership. Rehearse in a rolled-back transaction
  and guard the exact original values before applying the requested repair.
- P6: regular Cycle Count waits for a successful item/yard stock read before
  confirmation; an error cannot silently freeze the old stock balance.

Setup addition: one additive nullable-column migration for packed snapshots and
comparison provenance; existing rows retain their original count and variance.
No new dependencies. Schema rollback is rehearsed on a disposable database.

P2 correction after inspecting canonical load writers: local loading clears current packed fields and retains cumulative loaded quantities. Do not subtract historical loaded quantity from new packing. Deduct only fulfilled physical quantity not already cleared by a local load (`max(fulfilled - loaded, 0)`). Reload cycles also clear packed fields after each load. Regression examples: current packed 300, fulfilled 100, locally loaded 100 => packed 300; same with locally loaded 0 => packed 200. This corrects the initial test assumption, not the user formula.
