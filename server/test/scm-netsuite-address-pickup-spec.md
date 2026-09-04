# NetSuite-address PO pickup acceptance

## Contract

- A PO whose active vendor mapping is `__USE_NETSUITE_ADDRESS__` displays its NetSuite vendor label and vendor address as the canonical derived pickup; it does not invent a configured local-yard option.
- Saving another schedule field, including changing Method from `MBT` to `Vendor`, must accept the unchanged derived label when an older browser submits the full visible row, and must keep the stored schedule pickup unset.
- A current browser renders a pickup with no configured options as read-only and omits it from the save patch.
- A pickup value unrelated to the PO's NetSuite vendor remains invalid with `SCM_PO_PICKUP_YARD_INVALID`.
- A rejected pickup must not partially change Method or pickup state.
- Configured local-vendor yards, grouped PO intersections, split PO mutability, reconciliation, and Driver PWA behavior remain unchanged.

## Production regression shape

`POB03560` uses NetSuite vendor ID `6963`, vendor label `Castle Building Centres Group Ltd.#1580`, and the active `__USE_NETSUITE_ADDRESS__` mapping. It has no local vendor-yard records. Its schedule row derives the pickup label from NetSuite while storing no explicit pickup override.

## Verification

- Rollback-only PostgreSQL integration test with the production-shaped mapping.
- Existing route-option unit tests and schedule concurrency tests.
- Focused changed-line coverage and mutations that remove either the server no-op compatibility rule or the read-only client guard.
- Full predeploy suite before deployment; app and worker use one immutable image and Driver PWA assets must be byte-identical.
