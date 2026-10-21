# Pickup lookup for Qin at 3445

Spec approval: not obtained (autonomous run). This is an operational follow-up to
the previously deployed pickup line scoping fix. No new runtime change is assumed.

Failure model: the order was placed in 2967 and has inventory lines in both yards;
whole-order authorization can reject a 3445 operator and the frontend then resets
the yard. An admin account masks the denied access. Verify through the actual
browser and HTTP authentication/authorization with a regular operator having
Qin's current grants, [1, 15]. All fixtures run in a disposable isolated database.

Acceptance criteria:

- L1: A regular operator selects 3445 and enters SOA10099 or SOA10159. The order's
  placement is 2967 and its two physical lines belong to 3445 and 2967. Lookup
  succeeds, renders only the 3445 line, and keeps the selected yard and pickup
  screen. Verify both Enter and Find Order.
- L2: Lookup returns no 2967 line and does not change either line's draft.
- L3: A request for yard 2967 with the same operator is denied before lookup data
  or mutations; selecting 3445 grants no authority in 2967.
- L4: Run the same reproducer against the captured app source before the previous
  fix, observing failure on behavior, and against the deployed source, observing
  success. Read the live orders and Qin's current grants without changing them.

Setup: existing Playwright/Node/HTTP/Postgres tools; no new dependency, schema,
git initialization, commits, production account changes or NetSuite writes.
Use the standard bounded isolated Compose runner with teardown registered before
startup. Keep logs and browser screenshots; remove disposable containers, volumes
and networks, and verify production health and both Docker container listings.

Diagnostic refinement: the reproduced old denial immediately reloads the page,
which can discard Chromium's response body. For failed lookup diagnostics, record
the HTTP status and the observed return to yard selection; read JSON only on
success. The expected status remains 200 for all four authorized lookup cases.
