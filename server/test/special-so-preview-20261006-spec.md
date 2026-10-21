# Special SO verification and pickup-to-delivery fee

Scope: SPREQ-000030/SOB122131 and the pre-SO Sales header. Autonomous bug-fix run;
spec approval not obtained separately. The user confirmed that the current
NetSuite SO lines, including the -100 adjustment, must be retained.

1. A reviewed SO with three SQFT materials (99.79, 95.94, 287.82 at 5.98), PC
   materials, PALLET, and unitless Delivery Charge passes when all values match.
   Absent and null REST units both mean no UOM. Explicit material units remain
   exact: 866 is SQFT and 865 is PC.
2. Changed items, quantities, material UOM, prices, descriptions, pack quantities,
   discounts, added or missing lines, customer, and yard still reject linking.
   Generated cases must test both acceptance and rejection, including zero fees.
3. Before SO creation, selecting Delivery in the saved Sales header immediately
   shows the fee input. It accepts a nonnegative rate (including zero), retains
   unsaved values through method switches and rerenders, and submits the value.
   Legacy blank fees remain optional; previously saved numeric fees require a
   valid value. Pickup hides/disables the input and clears its managed fee.
4. Saving the header stores the fee atomically and adds or updates exactly one
   unitless customer Delivery Charge in an existing SO draft. Pickup removes the
   managed charge. Material and PO drafts, stock checks, decisions, notes, and
   progress are preserved. Quotes and SO preparation use the saved fee.
5. Invalid input, stale revisions, competing saves, and failed audit writes leave
   no partial header or fee changes. Existing request authorization applies.
6. SPREQ-000030 recovery uses the existing manual-reference link workflow after
   verifying SOB122131, customer 5409, yard 1, all current seven lines, no execution,
   and the unique owning request. Preserve the confirmed NetSuite order, retain
   the historical reviewed draft and audit trail, record the approved differences,
   clear the failed creation state, and retrieve the actual NetSuite PDF. No SO
   is created, repriced, or written to NetSuite during recovery.

Failure model: false-positive UOM comparison is checked by regression and generated
tests; false-negative commercial comparisons by adversarial mutations; lost or
duplicate customer fees by HTTP/browser tests; partial writes and competing
revisions by rollback/concurrency tests; unrelated deployment drift by live
source/configuration hashes; accidental duplicate SO by a read-only NetSuite
boundary and the existing manual link path.

Setup: use the cached repository test image, standard isolated Compose configuration,
mbbs-tests.slice, fixed memory/CPU/PID/tmpfs bounds, and test-only credentials.
No dependencies, schema changes, or git commits. Save baseline source, test logs,
coverage, mutation results, and deployment/recovery evidence. Register teardown
before creating containers and remove all task test containers, volumes, networks.
