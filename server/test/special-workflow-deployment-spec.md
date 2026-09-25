# Special workflow production deployment — 2026-09-24

The user's explicit “deploy” instruction authorizes release preparation,
production migration 225, application/worker cutover and verification. Continue
the existing old-coder Tier 3 evidence process without another approval prompt.

- Patch only this workflow's verified changes onto each currently deployed
  app/worker image. Keep each service's unrelated code and runtime configuration.
- Add the verified NetSuite pickup method mapping: `SPECIAL_STOCK_PICKUP_METHOD_ID=1`
  (`Pick-Up`); the existing delivery method is 2 (`Delivery`). These IDs were read
  from live NetSuite transaction metadata; do not create test orders in NetSuite.
- Preserve rollback images, private container snapshots, schema and affected-table
  backups. Apply exactly migration 225 transactionally with bounded lock/statement
  timeouts and a migration ledger entry. Keep PostgreSQL and Ollama running.
- Verify candidate images using isolated workflow regression tests and Sales/SCM
  browser checks. Verify the worker's special-order backend against its own image.
- Before restart, require no in-flight Special, Operator posting or webhook
  operation. Preserve environment, mounts and commands apart from the explicit
  pickup setting. Roll back app/worker images if cutover verification fails;
  retain the additive database migration and evidence.
- After restart, verify health, runtime hashes, migration/view, authenticated
  read boundaries, anonymous denial and served asset hashes through localhost
  and the existing public hostname. Confirm native NetSuite item/UOM metadata
  using read-only calls; do not submit an SO, PO, fulfillment or receipt.
- Leave the seven isolated review examples in their existing review database.

Failure model: scoped patches prevent unrelated releases; candidate tests catch
missing imports/schema assumptions; exact image hashes prevent stale evidence;
private backups and transaction boundaries protect migration recovery;
runtime configuration comparisons prevent credential/mount drift; zero active
operation checks and image rollback constrain restart failures.

Deployment finding: the integration role can read native unit IDs on item
records but cannot read the separate NetSuite Units list. Resolve exact configured
sales/stock/purchase labels from those permitted item fields first, without any
quantity conversion; reject ambiguous IDs. Keep the existing full-unit lookup
for other units and never substitute an arbitrary unit. Two RED regression tests
and two extra manual mutants cover this narrowly scoped readiness correction.
Both `vendor_pickup` and `yard_pickup` must produce SO `custbody3.id = "1"`;
`mbt_delivery` must produce `"2"`, as clarified by the user during deployment.
