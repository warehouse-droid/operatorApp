# Special order REST units correction and SPREQ-000007 recovery

Spec approval: not obtained (autonomous run). User explicitly authorized retrying
SPREQ-000007 and prohibited retrying SPREQ-000006. Tier 3: order quantities,
prices, duplicate creation and recovery state affect financial records.

Observed contract: the live REST GET of SOB121366 returns item `units` as
`"866"` and pallet `units` as `"246"`. SuiteQL resolves the requested PC unit
for item 2055 to 865. Case 62 / SPREQ-000007 has a definitive HTTP 400
INVALID_VALUE rejection at item.items[0].units, an attention operation and no
sales order marker. Its approved draft is 500 PC at 17 plus 11 EACH at 40.

Acceptance scenarios:

1. SO and PO payloads serialize the resolved unit ID as a string, including
   IDs 865 and 246. Preserve item identities, descriptions, quantities, rates,
   and memo marker; absent unit IDs remain absent.
2. Description synchronization accepts scalar REST unit IDs as well as existing
   reference-shaped fixtures. It verifies the linked unit before PATCH and
   rejects unit changes on any original line after PATCH.
3. Quantity planning and replay accept scalar REST units, preserve all units,
   rates and unrelated lines, and reject a changed unit before any PATCH.
4. Existing marker recovery and durable submission locks still prevent blind
   retries. No generic automatic resubmission is added.
5. Recovery is restricted to case 62 / SPREQ-000007, the observed operation,
   revision and definitive units error, with a fresh marker check, durable
   audit and unchanged draft verification. Claim and submit through existing
   workflow guards. Verify one linked order with exactly the intended items,
   units, quantities and rates. SPREQ-000006 is never rearmed or submitted.

Failure model: wrong REST type (contract regression); silent quantity/rate
change (property tests and live readback); external unit edits (adversarial
pre/post verification); duplicate order (existing service lock tests and fresh
marker recovery); concurrent retry (revision/operation checks); deployment
overwrites unrelated work (scoped source hashes and rollback image).

Setup: use the existing isolated Docker test runner with its pinned Node,
fast-check, c8, TypeScript and ESLint. Add focused tests, a reproducible check
script and recovery/deployment evidence. No dependencies, migrations or Git
commits. Preserve the pre-existing dirty worktree. Runtime scope is the three
special-order payload/adapter modules; no UI changes. Deploy a narrow layer
over the currently running image and preserve its configuration.

Verification: focused regression tests must fail before implementation; full
special-workflow unit/property/integration suites, changed-line coverage,
types, lint, seeded shuffled suite, manual mutants (including property-only
runs), secret scan and live readback. UI/benchmark/dependency audits are not
applicable because their surfaces and dependencies do not change.

Additional retained behavior: unrelated transaction lines may omit units,
rates and descriptions; description and quantity updates must preserve these
omissions. Exercise this with generated unit IDs and kill a mutant that makes
unrelated units mandatory. This closes a meaningful existing coverage gap.

Observed follow-up on the authorized retry: scalar units passed, then NetSuite
returned HTTP 400 USER_ERROR at item.items[1], "Please enter value(s) for:
Location." No order was found by the exact marker. The pallet inventory line
requires its own location; the header is insufficient. Extend acceptance:
SO and PO material/ancillary lines each use the exact resolved header yard as
their location reference. Preserve every other payload value. Recovery is now
restricted to the resulting revision 11 and its observed location rejection.
