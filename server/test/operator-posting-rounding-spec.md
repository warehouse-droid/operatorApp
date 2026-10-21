# General IF / IR quantity rounding (2026-10-10)

The user authorized a general fix for the 0.0002 rounding discrepancy, deployment,
and recovery of the existing IF157392 for SOB122432. This specification is stated
and executed autonomously; separate specification approval was not obtained.

Tier 3: this verifier releases durable inventory posting operations. Failure
modes are accepting a real shortage, accepting a wrong order/item/yard, losing
an existing transaction identity, repeating a transform, completing twice,
invalid non-finite quantities, and deploying unrelated workspace changes.

Acceptance scenarios (append-only):

1. The existing common NetSuite posting verifier accepts positive quantities
   differing by at most **0.0002 in the posted sales unit**, in either direction.
   This applies to SO IF, TO IF, PO IR, and TO IR. No quantity is rewritten or
   rounded in the posting payload or physical records.
2. The concrete IF157392 line-2 comparison (submitted 60.7602 SQFT, observed
   60.76 SQFT) verifies when all transaction identities, lines and locations
   match. Other line quantities 91.14 and 21.26 remain required.
3. Differences **0.000201**, **0.0003**, **0.01**, and one whole unit are rejected
   in either direction. The allowance is absolute and never percentage-based.
   Floating point boundary arithmetic may use only machine-roundoff slack,
   capped at 0.0000000001 to avoid scaling the allowance for large quantities.
4. Missing/zero/negative/non-finite lines, duplicate/extra positive lines, wrong
   source/type/external ID, wrong item and wrong location still fail verification.
5. Recovery uses the saved request and the existing external-ID fulfillment,
   performs **zero transforms**, finalizes once, and a repeated processor call
   performs no additional remote work or local completion. A discrepancy above
   the allowance leaves the operation held.
6. Recovery of IF157392 is scoped to its existing command. Fresh NetSuite
   readback must prove the same IF, source, external ID, positive lines, items
   and yard before normal audited resume. Its prior failed attempt is retained;
   completion records the recovered transaction and releases the existing claim.

Setup and release plan: use existing pinned Node, fast-check, c8, TypeScript,
ESLint and the standard bounded isolated Compose runner. No new dependency,
schema migration, git checkpoint commit, or production credential in tests.
Retain logs/source hashes, remove all disposable containers/databases/networks
on every exit, and check both Docker container lists plus production health.
Test the exact live-source candidate. Run the full posting component regression
suite, generated boundary properties, real repository recovery/finalization,
changed-code coverage, manual mutants including property-only runs, baseline
type/lint comparison, source/secret checks and randomized regression order.
Deploy only the common verifier over the captured app image; the webhook worker
runs synchronization, not the posting processor. Preserve configuration, the
recent pickup UI changes and other running services. Keep a rollback image.

## User clarification (supersedes the earlier threshold and payload clauses)

The user clarified the meaning as using the NetSuite quantity for IF/IR when
the variance is below a threshold in SQFT, completing locally normally. The
threshold was first clarified as below 0.002 SQFT, then revised by the user to
**strictly below 0.01 SQFT**. This latest instruction controls the implementation.

7. For SQFT, both 0.0002 and 0.009999 differences are accepted in either
   direction. Exactly 0.01 and larger are held. Other units retain their existing
   strict quantity comparison. Missing, wrong or conflicting unit evidence
   must not gain the SQFT allowance.
8. Before new SO/TO IF and PO/TO IR posting, a nearly equal local quantity uses
   the positive NetSuite remaining quantity in the durable payload. Zero
   availability cannot become a new positive posting. Legitimate partial
   quantities remain partial; quantities are never rounded to an arbitrary
   number of decimal places. Retain original local physical quantities and
   record the requested and posted quantities in reconciliation evidence.
9. Local IR finalization uses the accepted NetSuite quantity with the existing
   stable local line mapping, eliminating a rounding-only local remainder.
   Previously uncertain IF/IR records within the SQFT allowance are recovered
   against the existing transaction and its actual quantities. Saved original
   requests remain immutable, and no duplicate transaction is created.

10. The threshold remains strict for decimal quantities at large magnitudes.
    A generated boundary case at several million SQFT showed that a 0.01
    subtraction can lose more than 0.0000000001 to machine roundoff. The
    boundary guard is therefore capped at 0.00000001; it subtracts the guard
    from the limit and never increases the accepted discrepancy. This replaces
    the earlier machine-roundoff cap. No posting quantity itself is rounded.
