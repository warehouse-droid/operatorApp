# LOINC-035516 pickup correction — 2026-09-28

SCM selected TECHO BLOC Vaughan for LOINC-035516 (NetSuite POB03914,
1007015), while the PO parser fallback retained TECHO BLOC Ayr. The linked
SOM06647 allocation read that fallback directly, producing an Ayr pickup in
plan 340 on CC46868, assigned to Li.

The user confirmed the Vaughan pickup was still pending and explicitly asked
to reopen and correct the stop. The correction was first rehearsed with all
writes rolled back, then applied through the existing stop-reopen, vendor-yard,
plan-save and record-location correction functions. The plan advanced from
revision 49 to 50; the same stop and truck assignment were retained. Other
loads and other driver records were compared and preserved.

- Driver record: 5017, now pending with no start/completion timestamp.
- Stop: `stop-02e9ef23-1301-4b99-88c1-1c2178821c59`.
- Pickup: TECHO BLOC Vaughan, 720 Arrow Rd. North York, ON M9M 2M1.
- Reopen correction: `44fe77d4-30fc-4e03-a20b-92f037f88463`.
- Location correction: `dc00edc9-4348-4c73-aa81-bc998a25a3e2`.
- Dispatch audit: 24554. The normal plan-save history retains the prior plan.

The permanent lookup change reads the SCM pickup for the PO's visible reference
in linked allocation projections and linking options, preserving split-specific
selections, explicit pickup-address overrides and ordinary PO fallbacks.
Opening-day rows do not multiply allocations. It does not change automatic
handling of manually inserted or already recorded route stops.

Validation used an isolated temporary database. Before the fix, four of six
incident regressions failed with Ayr instead of Vaughan. Afterward, all 47
selected integration/unit regressions passed, including existing split-link,
route-residual and recorded-driver-work tests. Evidence and source hashes are
in `test-artifacts/po-pickup-yard-20260928/validation.json`.

Only `src/dispatch-repository.js` and `src/dispatch-po-pickup-sql.js` were layered
onto the captured production image. App and webhook worker now run image
`sha256:3672c643640c4a1109e131555224667f89b7a49b1ea0f5dbf01a5198dab5386d`.
Health, runtime hashes and unchanged configuration/dependencies were verified.
Rollback image: `mbbs-operator-app:rollback-po-pickup-yard-20260928`.

A post-deployment read-only check confirmed Li's pickup remains pending at
Vaughan, SOM06647's PO manifest also resolves to Vaughan, and the next driver
job is travel from 12441 to TECHO BLOC Vaughan. The pickup retains the normal
two-photo requirement. The driver should synchronize and refresh the route
before starting it again.
