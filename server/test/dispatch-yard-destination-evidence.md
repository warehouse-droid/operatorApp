# SOA08768 yard destination — 2026-09-15

SOA08768's saved pickup is `145 Valleymede Dr, Richmond Hill, ON L4B1T3` and its saved destination is `2967 Kennedy Rd, Scarborough, ON M1V 1S9`. Read-only checks of the order, Dispatch projection, and recent address-edit audit entries confirmed the address was present. The browser's `hasUsableDispatchAddress` rejected three hard-coded yard street prefixes, causing both the misleading missing-address card and the planning refusal.

The fix requires a nonblank SO destination and accepts yard destinations, including return trips. No order records or plans were changed. Other planning eligibility checks remain in place. The Dispatch script version was updated so reloading fetches the fix.

## Verification

- The new unit and browser regressions failed against the original source specifically because the 2967 destination was rejected.
- After the fix, all **26** focused tests passed: yard destinations, compact pool cards, missing destinations, split detail saves and browser refresh, required pickups, and fulfilled-SO card restrictions.
- The browser test planned the customer pickup followed by the yard drop, checked both route addresses, and verified that attempting to add a blank-destination order leaves the stops unchanged. No browser errors occurred.
- JavaScript syntax and whitespace checks passed.
- Tests ran in disposable containers with no external network or production database access.

Logs and browser evidence: `server/test-artifacts/yard-destination/`.

## Deployment

The live app was updated to `mbbs-operator-app:yard-destination-20260915-v1`, containing only `public/dispatch.js` and `public/dispatch.html` over the current live image. The release script verifies the exact two-file change, source hashes, test log, and unchanged prior runtime before applying. App health and both served asset hashes passed after deployment.

A final read-only production check ran the installed validator against SOA08768's current saved destination: accepted. It also verified that a blank destination remains blocked. The first check used the audit entry's postal-code spacing for the pickup; the current saved value omits that space. The final check uses the current record verbatim, with both results retained in the session tool history.

Prior assets, runtime metadata, deployment result, and the release script with automatic rollback are retained in `/home/ubuntu/operatorapp-deploy-backups/yard-destination-20260915/`. The worker and database containers were not recreated.
