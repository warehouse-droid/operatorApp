# Encoded Operator order references — confirmation fix

The user reported `invalid input syntax for type bigint: "VRMA%3ARP-UNI-AYR-3445-0914-1"` while confirming RP-UNI-AYR-3445-0914-1. Live logs place the failure in the Operator yard guard, before confirmation. `decodeURI` leaves the reserved colon encoded, while Express decodes a route parameter with `decodeURIComponent`.

Spec approval: not obtained (autonomous run). Follow the old-coder Tier 3 workflow because the change touches authorization. Reuse existing dependencies and isolated Docker test tooling. Make no Git commits or dependency changes. Prepare a minimal release over the current deployed image; preserve concurrent workspace changes. Confirm test fixtures only; verify the real order read-only so its chosen quantities remain the Operator's decision.

## Acceptance scenarios

1. An assigned Operator can read and confirm a line, confirm a page and adjust packed quantity through a URL containing `VRMA%3ARP-UNI-AYR-3445-0914-1`. The same canonical VRMA is checked for yard permission and changed by the route. The quantities returned and stored match the submitted test quantities.
2. An Operator without the stored pickup yard receives 403 for those encoded requests, even if the request supplies another allowed yard. No header, line or inventory changes occur.
3. Decode each captured URL identifier exactly once, after identifying route boundaries. Encoded slash/question/hash/percent characters remain part of the identifier and cannot create another path segment or query. Already decoded JSON identifiers are not decoded again.
4. Malformed percent encoding returns a controlled 400 before a database lookup. Numeric IDs, negative split IDs, local COs, saved orders, return drafts, consolidation and job IDs retain their existing yard checks.
5. The actual reported order resolves read-only with the encoded URL identifier after release. Existing fulfillment, receipt, load, Driver and posting records are not changed by verification.

## Evidence

Record RED/GREEN HTTP tests, encoding properties and adversarial cases, regression baselines, changed-line coverage, mutation checks including property-only runs, lint/types, source hashes and the exact deployment. No claim is made that this fixes unrelated pre-existing test failures. If a new assertion already passes, demonstrate its sensitivity with a throwaway mutant.
