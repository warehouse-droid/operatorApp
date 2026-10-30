# Shared MBT delivery rates — configuration correction

The user reported `The incoming bin needs one matching delivery distance rate`
and explicitly confirmed that the existing delivery rates apply to all bin sizes.
The active delivery card's five distance bands were restricted to 14YD.

Published version 3 of `DELIVERY_CHARGE_MBT_2026_RATE`, ID
`925d310d-c42c-4706-83c5-64deac91967a`, through the existing clone, replace, validate
and activate services in one transaction. Version 2 and its child rate evidence
remain available for historical quotes. Existing amounts, distance boundaries,
yard restrictions, currency and other configuration were compared for equality;
only the new version number and distance-band bin scope changed.

Operational verification: before the change, 20 of 80 combinations had one
matching rate; afterward all 80 did. The matrix covers the four active sizes
(14YD, 20YD, 30YD, 40YD), both configured origin yards, zero distance, all band
boundaries and their next metre, and 100 km. The normal rate validator passed.
Committed readback confirms version 3 is active, version 2 retired, all five
bands have unrestricted bin scope, and all four command audit events exist.
The Front Desk configuration service returns version 3. Application health passed.

This was an authorized configuration operation, with no application source or
price-calculation changes. No synthetic orders, test containers or disposable
databases were created. A full code test suite was not rerun for this data-only
correction; the app's rate validator and direct operational readback were used.
Existing bin rental/deposit settings and origin-yard rules are separate from
this confirmed delivery-pricing correction.

The maintenance procedure is persisted in
`tools/mbt-shared-delivery-rates-20261026.mjs`. It supports planning and an
`--apply --expected-hash=<plan sourceHash>` operation when sent to `node
--input-type=module -` in the live application container. Revision checks,
source-graph hashing and an outer transaction prevent stale or partial updates.
The resulting plan, application audit and Front Desk readback are retained under
`deployments/mbt-shared-delivery-rates-20261026` as operational records.
