# Default CM descriptions and CMB26105 correction

Deployed at 2026-10-28T19:10:50Z as
`mbbs-operator-app:return-cm-description-20261028`. The five live source hashes
match the validated candidate. Application health, configuration, and the other
production services passed verification. No migration or dependency was added.

New version-5 Credit Memos omit item descriptions so NetSuite supplies the item
defaults. Historical intents retain their original payload and verification.
The SO reference and operator memo remain. Source row identities stay in the
immutable application intent, and ordered items, rates, quantities, units,
reasons, locations, and fee rows remain strictly verified.

An explicit operational price correction is recorded separately in the existing
return sync event history. It is bound to the complete original intent and exact
CM ID, permits only declared stock rate changes, and requires verified remote
rows and amounts. Only successful events affect subsequent reconciliation. No
HTTP endpoint or automatic repricing was introduced; the original intent and
its database immutability trigger remain unchanged.

Final verification command:
`sudo -n bash server/tools/run-return-cm-description-checks.sh`

- 270 return tests passed: 33 existing enhancement acceptance cases and 237
  regression cases, including 10 new description/adjustment cases.
- The 10 new cases also passed separately and in reversed file order. The new
  price property ran 100 generated cases with an independent integer oracle.
- Eight deliberate mutants were killed, including a separate property-only
  incorrect-rate mutant. Original versions remained untouched in every run.
- Syntax, scoped ESLint, domain types with explicit I/O declarations, and secret
  scan passed. No dependencies were added.
- Across the five affected modules, coverage was 98.75% lines/statements
  (796/806), 100% functions (68/68), and 90.92% branches (511/562). The new
  adjustment module had 100/100 covered lines, 8/8 functions, and 46/48 branches.
  Existing repository coverage thresholds were retained.

The initial seven unit cases failed before implementation. Intermediate failures
identified a mutable synthetic request capture, the wrong retry entry point in
the reconciliation fixture, and a property oracle applying the percentage before
rounding the gross amount. The transport capture was cloned, the actual batch
reconciliation entry point was used, and the oracle was aligned with the existing
documented pricing contract. ESLint prompted smaller validation helpers. Coverage
was measured with the full return suite after a focused-only run correctly failed
the repository thresholds. No threshold or behavioral check was weakened.

Browser checks were not repeated because this release changes server posting and
verification only. The complete return suite includes the existing UI behavior
tests. General server-wide type/lint adoption is outside this change; the domain
modules were checked against explicit declarations for existing I/O boundaries.

All tests used the standard bounded disposable Compose environment and unique
retention directories without production credentials or data volumes. Every
failed and successful run removed its containers, temporary database, network,
logs, coverage files, and temporary source copies. Final running/stopped Docker
listings contained only the four production containers; task networks and
volumes were absent and production health passed.

## Authorized live result

`server/tools/return-rb000040-apply.mjs` updated existing CM 1098335/CMB26105 for
RB-000040 while holding its application reconciliation lock. Existing line IDs
and unique keys were preserved; no duplicate inventory row or new transaction
was created. A rollback payload was saved before writing, and failed verification
would restore the original amounts. Both current rows use exact item defaults:
the product description from NetSuite and a blank description for Restocking Fee.

NetSuite readback verified stock quantity 11.66, rate 1, amount 11.66; adjacent
35% fee rate/amount -4.08; subtotal 7.58; tax 0.99; total 8.57. Adjustment event
15656 was recorded. The original admitted stock rate remains 0, the current
verified CM rate is 1, and application reconciliation returned `succeeded`.
The user-requested test values remain on the CM. The source SO was not edited.

The automatic notification still has one sent attempt. The two existing customer
messages were created at 18:20:20Z and 18:25:38Z, before this change; no message
was sent by this operation. An initial final-check count incorrectly assumed
only one historical message; checking timestamps confirmed the user's earlier
manual test and no new delivery.

Operational before/after, rollback, payload, deployment and final verification
records are retained in `server/deployments/return-cm-description-20261028` and
the private `/app/data/return-operations` audit directory. NetSuite API method
selection followed Oracle's [Credit Memo documentation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_164460021767.html).

Spec authorization and known limitations are recorded in
`server/test/return-cm-description-spec.md`. The observed live result verifies
this CM and its current defaults, not every account-specific NetSuite workflow.
