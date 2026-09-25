# Existing NetSuite customers only — September 22, 2026

Spec approval: not obtained separately (autonomous run). The user explicitly
changed the workflow: customers are created in NetSuite, never by this app.
Implement and deploy the matching app change using the existing authorization.
Old-coder Tier 3 applies to Sales Order customer assignment and external writes.

## Acceptance scenarios

1. Save a local customer, site visit or quote without NetSuite mapping or billing
   details. There are no remote writes. Preserve quote/PDF totals and history.
2. Confirmation requires an existing active CAD customer for every represented
   account group: MBBS separately, MBT/MBR shared. Missing/invalid IDs reject the
   entire confirmation: no lock, order intent or partial mapping persists.
3. The confirmation popup provides existing-customer autocomplete for those
   groups, reuses saved mappings, and submits explicit choices atomically with
   confirmation. Stale customer revisions fail with a review message. Arbitrary
   text, archived customers and USD customers cannot be accepted.
4. Customers can be linked in advance in the local directory. Link changes and
   confirmation serialize; accepted jobs retain the intended customer identity.
5. The publisher only looks up and validates existing customers. Missing, inactive,
   wrong-currency, wrong-ID or missing-subsidiary results move the order to attention
   with a useful message. No customer or subsidiary relationship creation is sent.
6. Legacy jobs without an explicit accepted customer link cannot create an order.
   A previously committed order can still be found by its stable identity and
   verified. Retries do not duplicate orders or silently switch customers.
7. The RESTlet rejects `customer.ensure`, requires an explicit linked customer and
   verifies all required subsidiary memberships before Sales Order creation. The
   customer-creation implementation and relationship writes are removed. Even
   hostile/direct requests cannot supply a different order customer.
8. Remove customer form/status configuration from UI, validation, readiness and
   outgoing order payloads. Ignore obsolete saved fields. Keep the verified MBBS
   profile/location, all unrelated settings and external posting gates unchanged.
9. Shared MBT/MBR customer mappings still support independent company orders;
   idempotent confirmations and lost-response order recovery remain intact.
10. Preserve desktop, phone and offline visit/quote workflows, including the
    recently deployed local-customer autocomplete and site-only removal.

## Failure model and setup

- Accidental remote customer/relationship writes: actual RESTlet sandbox boundary
  assertions, worker transport action assertions, direct hostile calls, mutations.
- Wrong customer or partial company acceptance: database rollback, mapping identity
  checks, stale revisions, concurrent confirmation/relink and group properties.
- Old queued payload bypass: direct legacy-job tests and persisted-customer tests.
- Order duplication after timeouts: existing recovery suite and mutation checks.
- Misleading UI/validation: real browser confirmation, admin settings, search and
  phone layout; preserve unsaved/queued work through existing regression suites.

Reuse the pinned Docker runner and disposable PostgreSQL 18. Add acceptance tests,
browser cases, evidence scripts and a 3–5 case isolated-copy mutation runner.
No new dependencies, commits or schema migration. Run full Field Sales tests,
lint/types, merged changed-line coverage, property examples, mutations and shuffled
tests. Existing creation assertions are explicitly superseded by the user's new
policy; preserve their independent-order, identity and recovery assertions.
Deploy only verified changed files over the current live image. Read-only live
checks follow deployment. Do not create external test records, enable posting or
deploy the NetSuite RESTlet to an account without its existing setup mechanism.

## Addendum after the adversarial pass

- Oversized customer IDs must return a validation error, without a database error
  or partial confirmation. The added regression initially reproduced bigint overflow.
- Remove only `customerFormId` and `customerStatusId` from saved company profiles
  through a revision-guarded settings transaction. Rehearse rollback, retain a
  private before/after copy and record an operational audit identity.
- Include a sixth manual mutation for an accepted customer ID differing from the
  worker's persisted customer ID; the worker must stop before any external call.
