# Stable split quantity drafts

Spec approval: not obtained (autonomous run).

The user requested SOA09140-S4 (4,588 SQFT) be replaced by S5 (2,232)
and S6 (2,356). The audit records identify this source and these entries.

Acceptance:

1. A split draft follows its transaction line ID when the same line is
   refreshed with a different local database row ID. Test both camelCase
   and snake_case line IDs.
2. Entering 2,232, refreshing the order, and entering 2,356 enables
   submission and sends exactly those quantities. Another refresh retains
   the same values.
3. Same-SKU transaction lines remain independent, including reordered
   refreshed lines; a shortage in one cannot offset an excess in another.
4. Local lines without transaction IDs retain their existing row-ID fallback.
5. Negative, missing, short, excessive and empty splits remain blocked.
6. The real resplit service produces suffixes S5/S6, retires S4 only,
   conserves 4,588 SQFT and retains completed sibling and route history.
7. Release only the frontend correction and its asset version over the
   captured running image. Preserve the previous fulfillment correction.
8. Use the existing guarded resplit operation for the requested live split
   after verifying source quantities, source status, next suffix and no
   concurrent plan editor. Record before/after operational evidence.

Failure model:

- Refresh loses quantity bindings: browser refresh during entry and VM tests.
- Shared SKU combines different lines: reordered multi-line tests/properties.
- Wrong totals pass: negative/short/excess regression and adversarial tests.
- Incorrect or duplicated live split: existing transaction locks, source
  signature, suffix checks, guarded API/service and after-state verification.
- Completed work changes: existing resplit integration/history tests and
  before/after sibling evidence.
- Deployment overwrites unrelated changes: captured source, two-file image
  overlay, hashes and concurrent deployment checks.

Setup: use existing Node, Playwright, fast-check, ESLint, TypeScript and
coverage tools in bounded disposable containers. No dependencies, schema
changes or commits. Add tests and task-specific release/evidence scripts.
Register teardown before test startup; remove test containers, disposable
volumes and unused networks even after failure. Keep logs and screenshots.
